/**
 * Test tracer manual mode
 *
 * @group e2e/tracer/manual
 */

import { randomUUID } from 'crypto';
import { Tracing } from '@aws-cdk/aws-lambda';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { App, Stack } from '@aws-cdk/core';
import { SdkProvider } from 'aws-cdk/lib/api/aws-auth';
import { CloudFormationDeployments } from 'aws-cdk/lib/api/cloudformation-deployments';
import * as AWS from 'aws-sdk';
import { getTraces, getInvocationSubsegment } from '../helpers/tracesUtils';

const xray = new AWS.XRay();
const lambdaClient = new AWS.Lambda();

describe('Tracer integration tests', () => {

  const expectedCustomAnnotationKey = 'myAnnotation';
  const expectedCustomAnnotationValue = 'myValue';
  const expectedCustomMetadataKey = 'myMetadata';
  const expectedCustomMetadataValue = { bar: 'baz' };
  const expectedCustomResponseValue = { foo: 'bar' };
  const expectedCustomErrorMessage = 'An error has occurred';
  const startTime = new Date();
  const invocations = 3;

  let integTestApp: App;
  let stack: Stack;
  const invocationsMap: { [key: string]: { serviceName: string; resourceArn: string } } = {};

  beforeAll(async () => {

    // Prepare
    integTestApp = new App();
    const account = process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT;
    const region = process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION;
    stack = new Stack(integTestApp, 'TracerIntegTest', {
      env: {
        account, 
        region 
      }
    });

    const functions = [
      'Manual',
      'Middleware',
      'Decorator',
      'Disabled',
    ];
    for (const functionName of functions) {
      const expectedServiceName = randomUUID();
      new NodejsFunction(stack, functionName, {
        functionName: functionName,
        tracing: Tracing.ACTIVE,
        environment: {
          EXPECTED_SERVICE_NAME: expectedServiceName,
          EXPECTED_CUSTOM_ANNOTATION_KEY: expectedCustomAnnotationKey,
          EXPECTED_CUSTOM_ANNOTATION_VALUE: expectedCustomAnnotationValue,
          EXPECTED_CUSTOM_METADATA_KEY: expectedCustomMetadataKey,
          EXPECTED_CUSTOM_METADATA_VALUE: JSON.stringify(expectedCustomMetadataValue),
          EXPECTED_CUSTOM_RESPONSE_VALUE: JSON.stringify(expectedCustomResponseValue),
          EXPECTED_CUSTOM_ERROR_MESSAGE: expectedCustomErrorMessage,
        },
      });
      invocationsMap[functionName] = {
        serviceName: expectedServiceName,
        resourceArn: `arn:aws:lambda:${region}:${account}:function:${functionName}`, // ARN is still a token at this point, so we construct the ARN manually
      };
    }

    const stackArtifact = integTestApp.synth().getStackByName(stack.stackName);

    const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
      profile: process.env.AWS_PROFILE,
    });
    const cloudFormation = new CloudFormationDeployments({ sdkProvider });
    await cloudFormation.deployStack({
      stack: stackArtifact,
    });

    // Act
    Object.keys(invocationsMap).forEach(async (functionName) => {
      for (let i = 0; i < invocations; i++) {
        await lambdaClient.invoke({
          FunctionName: functionName,
          Payload: JSON.stringify({
            throw: true ? i === invocations - 1 : false, // only last invocation should throw
          }),
        }).promise();
      }
    });
    
    // sleep to allow for traces to be collected
    await new Promise((resolve) => setTimeout(resolve, 120000));

  }, 900000);

  afterAll(async () => {

    if (!process.env.DISABLE_TEARDOWN) {
      const stackArtifact = integTestApp.synth().getStackByName(stack.stackName);
  
      const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
        profile: process.env.AWS_PROFILE,
      });
      const cloudFormation = new CloudFormationDeployments({ sdkProvider });
  
      await cloudFormation.destroyStack({
        stack: stackArtifact,
      });
    }

  }, 900000);

  it('Verifies that a when Tracer is used to manually instrument a function all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['Manual'].resourceArn;
    const expectedServiceName = invocationsMap['Manual'].serviceName;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(2);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        // Assert that there're no subsegments
        expect(handlerSubsegment.hasOwnProperty('subsegments')).toBe(false);
        
        const { annotations, metadata } = handlerSubsegment;

        if (annotations !== undefined && metadata !== undefined) {
          // Assert that the annotations are as expected
          expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
          expect(annotations['Service']).toEqual(expectedServiceName);
          expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
          // Assert that the metadata object is as expected
          expect(metadata[expectedServiceName][expectedCustomMetadataKey])
            .toEqual(expectedCustomMetadataValue);
          
          if (i === invocations - 1) {
            // Assert that the subsegment has the expected fault
            expect(invocationSubsegment.error).toBe(true);
            expect(handlerSubsegment.fault).toBe(true);
            expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
            expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
          } else {
            // Assert that the metadata object contains the response
            expect(metadata[expectedServiceName]['index.handler response'])
              .toEqual(expectedCustomResponseValue);
          }
        } else {
          // Make test fail if there are no annotations or metadata
          expect('annotations !== undefined && metadata !== undefined')
            .toBe('annotations === undefined && metadata === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 900000);

  it('Verifies that a when Tracer is used as middleware all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['Middleware'].resourceArn;
    const expectedServiceName = invocationsMap['Middleware'].serviceName;

    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(2);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        // Assert that there're no subsegments
        expect(handlerSubsegment.hasOwnProperty('subsegments')).toBe(false);
        
        const { annotations, metadata } = handlerSubsegment;

        if (annotations !== undefined && metadata !== undefined) {
          // Assert that the annotations are as expected
          expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
          expect(annotations['Service']).toEqual(expectedServiceName);
          expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
          // Assert that the metadata object is as expected
          expect(metadata[expectedServiceName][expectedCustomMetadataKey])
            .toEqual(expectedCustomMetadataValue);
          
          if (i === invocations - 1) {
            // Assert that the subsegment has the expected fault
            expect(invocationSubsegment.error).toBe(true);
            expect(handlerSubsegment.fault).toBe(true);
            expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
            expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
          } else {
            // Assert that the metadata object contains the response
            expect(metadata[expectedServiceName]['index.handler response'])
              .toEqual(expectedCustomResponseValue);
          }
        } else {
          // Make test fail if there are no annotations or metadata
          expect('annotations !== undefined && metadata !== undefined')
            .toBe('annotations === undefined && metadata === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 900000);

  it('Verifies that a when Tracer is used as decorator all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['Decorator'].resourceArn;
    const expectedServiceName = invocationsMap['Decorator'].serviceName;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(2);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there is one subsegment
          expect(handlerSubsegment?.subsegments?.length).toBe(1);
          const methodSubsegment = handlerSubsegment?.subsegments[0];
          // Assert that the subsegment name is the expected one
          expect(methodSubsegment.name).toBe('### myMethod');

          const { metadata } = methodSubsegment;

          if (metadata !== undefined) {
            // Assert that the metadata object is as expected
            expect(metadata[expectedServiceName]['myMethod response'])
              .toEqual(expectedCustomResponseValue);
          } else {
            // Make test fail if there is no metadata
            expect('metadata !== undefined')
              .toBe('metadata === undefined');
          }
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
        
        const { annotations, metadata } = handlerSubsegment;

        if (annotations !== undefined && metadata !== undefined) {
          // Assert that the annotations are as expected
          expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
          expect(annotations['Service']).toEqual(expectedServiceName);
          expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
          // Assert that the metadata object is as expected
          expect(metadata[expectedServiceName][expectedCustomMetadataKey])
            .toEqual(expectedCustomMetadataValue);
          
          if (i === invocations - 1) {
            // Assert that the subsegment has the expected fault
            expect(invocationSubsegment.error).toBe(true);
            expect(handlerSubsegment.fault).toBe(true);
            expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
            expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
          } else {
            // Assert that the metadata object contains the response
            expect(metadata[expectedServiceName]['index.handler response'])
              .toEqual(expectedCustomResponseValue);
          }
        } else {
          // Make test fail if there are no annotations or metadata
          expect('annotations !== undefined && metadata !== undefined')
            .toBe('annotations === undefined && metadata === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 900000);

  it('Verifies that a when tracing is disabled no custom traces are generated', async () => {
    
    const resourceArn = invocationsMap['Disabled'].resourceArn;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(2);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      expect(invocationSubsegment?.subsegments).toBeUndefined();
         
      if (i === invocations - 1) {
        // Assert that the subsegment has the expected fault
        expect(invocationSubsegment.error).toBe(true);
      }
    }

  }, 900000);

});
