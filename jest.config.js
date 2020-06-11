module.exports = {
    transform: {
        '^.+\\.ts?$': 'ts-jest',
        ".+\\.(html)$": "jest-transform-stub"
    },
    testEnvironment: 'node',
    testRegex: '/test/.*\\.(test|spec)?\\.(ts|tsx|js)$',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node', 'html']
};
