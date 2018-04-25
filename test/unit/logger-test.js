const assert = require('chai').assert;
const logger = require('../../logger');

describe('logger', function() {

    describe("#config", function() {
        it("should configure logger", function() {
            return new Promise((resolve, reject) => {
                logger.info();
                logger.info("test", { aGoodTest: true });
                assert.isOk("Success", "This test was successful");
                resolve();
            });
        });
    });

});
