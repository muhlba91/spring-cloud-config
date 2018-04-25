const yaml = require('js-yaml');
const fs = require('fs');
const cloudConfigClient = require('cloud-config-client');
const extend = require('extend');
const EventEmitter = require('events').EventEmitter;
const logger = require('./logger');
const ConfigEvents = require('./config-events');

class SpringCloudConfig extends EventEmitter {
    constructor(options) {
        super();

        this._options = options;

        this._remoteConfig = undefined;
        this._localConfig = undefined;

        this._bootstrapConfig = undefined; // The config to use for cloud config client
        this._config = undefined; // The initialized config instance

        // watcher config
        this._watchConfig = {
            interval: 60000,
            running: false,
            timerId: null
        };
    }

    startWatch(interval) {
        this._watchConfig.interval = interval || this._watchConfig.interval;
        this._watchConfig.running = true;

        if (this._watchConfig.timerId) {
            clearTimeout(this._watchConfig.timerId);
            this._watchConfig.timerId = null;
        }

        const that = this;
        this._watchConfig.timerId = setTimeout(() => {
            this._readCloudConfig(this._bootstrapConfig)
                .then((remoteConfig) => {
                    that.emit(ConfigEvents.CONFIG_REFRESH_EVENT, remoteConfig);
                })
                .catch((error) => {
                    that.emit(ConfigEvents.CONFIG_ERROR_EVENT, error);
                });

            if (!this._watchConfig.running) {
                this.startWatch();
            }
        }, this._watchConfig.interval);
    }

    endWatch() {
        this._watchConfig.running = false;
    }

    setOptions(options) {
        this._options = options;
    }

    load() {
        // options.bootstrapPath is optional
        if (!(this._options.configPath && this._options.activeProfiles)) {
            return Promise.reject("Invalid options supplied. Please consult the documentation.");
        }

        logger.level = (this._options.level ? this._options.level : 'info');

        return this._readConfig();
    }

    getConfig() {
        return this._config;
    }

    /**
     * Reads all of the configuration sources for the application and merges them into a single config object.
     *
     * @returns {Promise} Promise will resolve to the fully merged config object
     */
    _readConfig() {
        const that = this;

        return new Promise(function(resolve, reject) {
            // Load bootstrap.yml based on the profile name (like devEast or stagingEast)
            const theBootstrapPath = that._options.bootstrapPath ? that._options.bootstrapPath : that._options.configPath;
            that._readYamlAsDocument(theBootstrapPath + '/bootstrap.yml', that._options.activeProfiles)
                .then((thisBootstrapConfig) => {
                    thisBootstrapConfig.spring.cloud.config.profiles = that._options.activeProfiles;
                    logger.debug("Using Bootstrap Config: " + JSON.stringify(thisBootstrapConfig));
                    that._bootstrapConfig = thisBootstrapConfig;

                    return that._readApplicationConfig(that._options.configPath, that._options.activeProfiles);
                })
                .then((applicationConfig) => {
                    that._localConfig = applicationConfig;
                    logger.debug("Using Application Config: " + JSON.stringify(applicationConfig));

                    if (applicationConfig.spring &&
                        applicationConfig.spring.cloud &&
                        applicationConfig.spring.cloud.config &&
                        applicationConfig.spring.cloud.config.name) {
                        that._bootstrapConfig.spring.cloud.config.name = applicationConfig.spring.cloud.config.name;
                    }

                    return that._readCloudConfig(that._bootstrapConfig);
                })
                .then((cloudConfig) => {
                    that._remoteConfig = cloudConfig;
                    logger.debug("Using Remote Config: " + JSON.stringify(cloudConfig));

                    return Promise.resolve();
                })
                .then(() => {
                    that._generateConfig();

                    logger.debug('Using Config: ' + JSON.stringify(that._config));
                    resolve(that._config);
                })
                .catch((error) => {
                    logger.error(error);
                    reject(error);
                });
        });
    }

    /**
     * Read the application's configuration files and merge them into a single object.
     *
     * @param {String} appConfigPath Path to where the application yaml files can be found.
     * @param {String[]} activeProfiles The active profiles to use for filtering config files.
     */
    _readApplicationConfig(appConfigPath, activeProfiles) {
        const that = this;

        return this._readYamlAsDocument(appConfigPath + '/application.yml', activeProfiles)
            .then(
                (applicationConfig) => {
                    const appConfigs = [applicationConfig];
                    activeProfiles.forEach(function(activeProfile) {
                        const profileSpecificYaml = 'application-' + activeProfile + '.yml';
                        const profileSpecificYamlPath = appConfigPath + '/' + profileSpecificYaml;
                        if (fs.existsSync(profileSpecificYamlPath)) {
                            try {
                                const propDoc = yaml.safeLoad(fs.readFileSync(profileSpecificYamlPath, 'utf8'));
                                const thisDoc = that._parsePropertiesToObjects(propDoc);
                                appConfigs.push(thisDoc);
                            } catch(error) {
                                logger.error('Error reading profile-specific yaml: ' + error.message);
                            }
                        } else {
                            logger.debug('Profile-specific yaml not found: ' + profileSpecificYaml);
                        }
                    });

                    const mergedAppConfig = this._mergeProperties(appConfigs);
                    return Promise.resolve(mergedAppConfig);
                }
            );
    }

    /**
     * Reads the external configuration from Spring Cloud Config Server
     *
     * @param {Object} bootStrapConfig The bootstrap properties needed for Spring Cloud Config
     * @returns {Promise} The Spring Environment Object obtained from the Config Server
     */
    _readCloudConfig(bootStrapConfig) {
        return new Promise((resolve, reject) => {
            let cloudConfig = {};
            if (bootStrapConfig.spring.cloud.config.enabled) {
                try {
                    logger.debug("Spring Cloud Options: " + JSON.stringify(bootStrapConfig.spring.cloud.config));

                    cloudConfigClient.load(bootStrapConfig.spring.cloud.config)
                        .then((cloudConfigProperties) => {
                            if (cloudConfigProperties) {
                                cloudConfigProperties.forEach(function(key, value) {
                                    cloudConfig[key] = value;
                                }, false);
                                cloudConfig = this._parsePropertiesToObjects(cloudConfig);
                            }
                            logger.debug("Cloud Config: " + JSON.stringify(cloudConfig));
                            resolve(cloudConfig);
                        }, (error) => {
                            logger.error("Error reading cloud config: %s", error.message);
                            resolve(cloudConfig);
                        });
                } catch(e) {
                    logger.error("Caught error from cloud config client: %s", e.message);
                    resolve(cloudConfig);
                }
            } else {
                resolve(cloudConfig);
            }
        });
    }

    /**
     * Reads the yaml document and parses any dot-separated property keys into objects.
     *
     * @param {String} relativePath Relative path of the file to read.
     * @param {String[]} activeProfiles Profiles to filter the yaml documents on.
     */
    _readYamlAsDocument(relativePath, activeProfiles) {
        try {
            return this._readYaml(relativePath, activeProfiles)
                .then((yamlDoc) => {
                    return Promise.resolve(this._parsePropertiesToObjects(yamlDoc));
                });
        } catch(error) {
            return Promise.reject(error);
        }
    }

    /**
     * Reads the yaml file at the given relative path and merges multiple docs into a single object.
     * If 'profile' is specified then this method expects to filter the yaml for docs based on doc.profiles.
     * If no profile is specified, then only docs without an 'env' property will be read from the yaml.
     *
     * @param {String} relativePath Relative path of the file to read.
     * @param {String[]} activeProfiles Profiles to filter the yaml documents on.
     * @returns {Promise} Object representation of the given yaml file.
     */
    _readYaml(relativePath, activeProfiles) {
        const that = this;
        return new Promise(function(resolve, reject) {
            try {
                const doc = {};
                logger.debug('loading config file from: ' + relativePath);
                yaml.safeLoadAll(fs.readFileSync(relativePath, 'utf8'), (thisDoc) => {
                    if (that._shouldUseDocument(thisDoc, activeProfiles)) {
                        extend(true, doc, thisDoc);
                    }
                });

                resolve(doc);
            } catch(e) {
                logger.error(e);
                reject(e);
            }
        });
    }

    /**
     * Determines if the given yaml document should be used with regard to the
     * given profile. This provides similar functionality to spring profiles.
     *
     * @param {Object} document The yaml doc to check.
     * @param {String[]} activeProfiles The current profile names to filter docs by.
     * @returns {boolean} True if the given yaml doc applies to the given profiles.
     */
    _shouldUseDocument(document, activeProfiles) {
        let useThisDoc = false;
        if (document && !document.profiles) {
            useThisDoc = true;
        }// This document applies to all profiles
        else if (document && activeProfiles) {
            const documentProfiles = document.profiles.split(",");
            for (let i = 0; i < documentProfiles.length; i++) {
                if (documentProfiles[i]) {
                    if (documentProfiles[i][0] === "!") {
                        const excludeProfile = documentProfiles[i].substring(1);
                        if (activeProfiles.indexOf(excludeProfile) >= 0) {
                            return false;
                        } // This document should not be used
                    } else if (activeProfiles.indexOf(documentProfiles[i]) >= 0) {
                        useThisDoc = true;
                    } // This document applies to the profiles
                }
            }
        }
        return useThisDoc;
    }

    _generateConfig() {
        this._config = this._mergeProperties([
            this._bootstrapConfig,
            this._localConfig,
            this._remoteConfig
        ]);
    }

    /**
     * Takes an array of objects and merges their properties in order, from index 0 to length-1.
     * Identical properties in later objects will override those in previous objects.
     * This method does handle deeply nested property keys (like: {'spring': 'profiles': 'active': 'local'})
     *
     * @param {Object[]} objects Array of Objects containing properties to be merged
     * @returns {Object} Object containing the merged properties
     */
    _mergeProperties(objects) {
        const mergedConfig = {};
        for (let i = 0; i < objects.length; i++) {
            extend(true, mergedConfig, objects[i]);
        }
        return mergedConfig;
    }

    /**
     * Parses the dot-separated key-value pairs of an object into deeply nested Objects.
     * Example: 'spring.profiles.active': 'dev' -> 'spring': 'profiles': 'active': 'dev'
     *
     * @param {Object} propertiesObject Object containing properties to be parsed
     * @returns {Object} Object of deeply nested properties (not dot-separated)
     */
    _parsePropertiesToObjects(propertiesObject) {
        const object = {};
        if (propertiesObject) {
            for (const thisPropertyName in propertiesObject) {
                const thisPropertyObject = this._createObjectForProperty(thisPropertyName.split('.'), propertiesObject[thisPropertyName]);
                extend(true, object, thisPropertyObject);
            }
        }
        return object;
    }

    /**
     * Turns an array of key segments and value into a nested object.
     * Example: ['spring','profiles','active'], 'dev' -> { 'spring': 'profiles': 'active': 'dev' }
     *
     * @param {String[]} propertyKeys The key segments for the given property
     * @param {*} propertyValue The value associated with the given property
     * @returns {Object}
     */
    _createObjectForProperty(propertyKeys, propertyValue) {
        if (propertyKeys.length === 0) {
            return propertyValue;
        }

        const thisPropertyName = propertyKeys.shift();
        const thisPropertyValue = this._createObjectForProperty(propertyKeys, propertyValue);
        const thisObject = {};
        thisObject[thisPropertyName] = thisPropertyValue;

        return thisObject;
    }
}

exports.default = SpringCloudConfig;
exports.Events = ConfigEvents;
