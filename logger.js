let winston = require('winston');
let config = winston.config;

let loggingConfig = {
  transports: [
    new (winston.transports.Console)({
      timestamp: function() {
        return new Date().toISOString();
      },
      formatter: function(options) {
        return options.timestamp() + ' ' +
            config.colorize(options.level, options.level.toUpperCase()) + ' ' +
            (options.message ? options.message : '') +
            (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
      }
    })
  ]
};

module.exports = new (winston.Logger)(loggingConfig);
