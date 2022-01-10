module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.tests.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
