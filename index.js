/*
 * (c) 2020-2023 Feilner
 */

var PlatformAccessory, Service, Characteristic, UUIDGen;
var snap7 = require('node-snap7');

// Exports
module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  PlatformAccessory = homebridge.platformAccessory;
  homebridge.registerPlatform('homebridge-plc', 'PLC', PLC_Platform);
};

function PLC_Platform(log, config, api) {
  this.log = log;
  this.config = config;
  this.api = api;
  this.s7PlatformAccessories = [];
  this.S7Client = new snap7.S7Client();
  this.isConnectOngoing = false;
  this.S7ClientConnect();
}

PLC_Platform.prototype = {
  accessories: function(callback) {
      var log = this.log;

      if ( typeof(this.config.defaultPollInterval) === 'undefined' || this.config.defaultPollInterval === null || this.config.defaultPollInterval < 1) {
        this.config.defaultPollInterval = 10;
      }

      log.info("Add PLC accessories...");
      //create accessory for each configuration
      this.config.accessories.forEach((config, index) => {
          var accessoryNumber = index +1;
          var numberOfAccessories = this.config.accessories.length;
          log.info("[" + String(accessoryNumber) + "/" + String(numberOfAccessories) + "] " + config.name + " (" +  config.accessory + ")" );
          //call accessory construction
          var accessory = new GenericPLCAccessory(this, config, accessoryNumber);
          this.s7PlatformAccessories.push(accessory);
      });
      callback(this.s7PlatformAccessories);

      if (this.config.enablePolling) {
        log.info("Enable polling...");
        setInterval(function(param) {this.pollLoop( this.s7PlatformAccessories);}.bind(this),1000);
      }

      if (this.config.enablePush || this.config.enableControl) {
        this.port = this.config.port || 8888;
        this.api.on('didFinishLaunching', () => {
            if (this.config.enablePush && this.config.enableControl) {
              this.log.info('Enable push and control server...');
            }
            else if (this.config.enablePush) {
              this.log.info('Enable push server...');
            }
            else {
              this.log.info('Enable control server...');
            }
            this.listener = require('http').createServer((req, res) => this.httpListener(req, res));
            this.listener.listen(this.port);
            this.log.info('Listening on port ' + this.port);
        });
      }
      log.info("Init done!");
  },

  pollLoop: function(s7PlatformAccessories)  {
    s7PlatformAccessories.forEach((accessory) => {
      accessory.poll();
    });
  },

  forwardHTTP: function(logprefix, url) {
    require('http').get(url, (resp) => {
      if (resp.statusCode !== 200) {
        this.log.error(logprefix + " Forward failed with HTTP status: " + resp.statusCode);
        return;
      }
    }).on('error', function(e) {
      this.log.error(logprefix + " Forward failed: " + e.message);
    }.bind(this));
  },

  httpListener: function(req, res) {
    var data = '';
    var url = '';

    if (req.method == 'POST') {
        req.on('data', (chunk) => {
            data += chunk;
        });
        req.on('end', () => {
            this.log.info('Received POST and body data:');
            this.log.info(data.toString());
        });
    }
    else if (req.method == 'PUT' || req.method == 'GET') {
        req.on('end', () => {
            url = require('url').parse(req.url, true); // will parse parameters into query string
            if (this.config.enablePush && 'push' in url.query && 'db' in url.query && 'offset' in url.query && 'value' in url.query) {
              this.log.debug("[HTTP Push] (" + req.socket.remoteAddress + ") Received update for accessory:" + url.query.db + " offset:" + url.query.offset +" value:" + url.query.value);
              var db = parseInt(url.query.db);
              var offset = parseFloat(url.query.offset);
              var value = url.query.value;
              var offsetHandled = false;
              var dbHandled = false;
              this.s7PlatformAccessories.forEach((accessory) => {
                if (accessory.config.db == db) {
                  dbHandled = true;
                  offsetHandled = accessory.updatePush(offset, value) || offsetHandled;
                }
              });

              if  (typeof(this.config.mirror) != 'undefined' && this.config.mirror) {
                this.forwardHTTP("[HTTP Push]", this.config.mirror + req.url);
              }

              if(!dbHandled) {
                if  (typeof(this.config.forward) != 'undefined' && this.config.forward) {
                  this.forwardHTTP("[HTTP Push]", this.config.forward + req.url);
                }
                else{
                  this.log.warn("[HTTP Push] (" + req.socket.remoteAddress + ") " + "No accessory configured for db:" + url.query.db + " offset:" + url.query.offset +" value:" + url.query.value);
                }
              }
              else if (!offsetHandled) {
                this.log.warn("[HTTP Push] (" + req.socket.remoteAddress + ") " + "Offset not configured for accessory db:" + url.query.db + " offset:" + url.query.offset +" value:" + url.query.value);
              }
            }
            else if (this.config.enableControl && 'control' in url.query && 'db' in url.query && 'offset' in url.query && 'value' in url.query) {
              this.log.debug("[HTTP Control] (" + req.socket.remoteAddress + ") Received control request for accessory:" + url.query.db + " offset:" + url.query.offset +" value:" + url.query.value);
              var db = parseInt(url.query.db);
              var offset = parseFloat(url.query.offset);
              var value = url.query.value;
              var offsetHandled = false;
              var dbHandled = false;
              this.s7PlatformAccessories.forEach((accessory) => {
                if (accessory.config.db == db) {
                  dbHandled = true;
                  offsetHandled = accessory.updateControl(offset, value) || offsetHandled;
                }
              });

              if(!dbHandled) {
                if (typeof(this.config.forward) != 'undefined' && this.config.forward) {
                  this.forwardHTTP("[HTTP Control]", this.config.forward + req.url);
                }
                else {
                  this.log.warn("[HTTP Control] (" + req.socket.remoteAddress + ") " + "No accessory configured for db:" + url.query.db + " offset:" + url.query.offset +" value:" + url.query.value);
                }
              }
              else if (!offsetHandled) {
                this.log.warn("[HTTP Control] (" + req.socket.remoteAddress + ") " + "Offset not configured for accessory db:" + url.query.db + " offset:" + url.query.offset +" value:" + url.query.value);
              }
            }
            else
            {
              if (!this.config.enablePush && 'push' in url.query) {
                this.log.warn("[HTTP Push]  (" + req.socket.remoteAddress + ") enablePush is not set in platform config!");
              }
              else if (!this.config.enableControl && 'control' in url.query) {
                this.log.warn("[HTTP Control]  (" + req.socket.remoteAddress + ") enableControl is not set in platform config!");
              }
              else if (!('push' in url.query) && !('control' in url.query) ) {
                this.log.warn("[HTTP Push/Control]  (" + req.socket.remoteAddress + ") unknown operation: " + req.url);
              }
              else if (!('db' in url.query)) {
                this.log.warn("[HTTP Push/Control]  (" + req.socket.remoteAddress + ") parameter db is missing in url: " + req.url);
              }
              else if (!('offset' in url.query)) {
                this.log.warn("[HTTP Push/Control]  (" + req.socket.remoteAddress + ") parameter offset is missing in url: " + req.url);
              }
              else if (!('value' in url.query)) {
                this.log.warn("[HTTP Push/Control]  (" + req.socket.remoteAddress + ") parameter value is missing in url: " + req.url);
              }
            }
        });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end();
},

  mirrorGet: function(logprefix, parameter) {
    if ( 'mirror' in this.config && this.config.mirror) {
      var url = this.config.mirror + "/?push" + parameter;
      require('http').put(url, (resp) => {
        if (resp.statusCode !== 200) {
          this.log.error(logprefix, "Mirror failed (" + url + "): HTTP status " + resp.statusCode);
          return;
        }
      }).on('error', function(e) {
        this.log.error(logprefix, "Mirror failed (" + url + "): "+ e.message);
      }.bind(this));
    }
    return;
  },

    //PLC connection check function
  S7ClientConnect: function() {
      let typeName = ["invalid", "PG-Communication", "OP-Communication"]
      var log = this.log;
      var S7Client = this.S7Client;
      var ip = this.config.ip;
      var rack = this.config.rack;
      var slot = this.config.slot;
      var type = S7Client.CONNTYPE_PG;
      var rv = false;

      if ( 'communicationOP' in this.config && this.config.communicationOP) {
        type = S7Client.CONNTYPE_OP;
      }

      if (S7Client.Connected()) {
        rv = true;
      }
      else {
          log.info("Connecting to %s (%s:%s) %s", ip, rack, slot, typeName[type]);

          if (!this.isConnectOngoing) {
            this.isConnectOngoing = true;
            var ok = S7Client.SetConnectionType(type);
            if(ok) {

              ok = S7Client.ConnectTo(ip, rack, slot);
              this.isConnectOngoing = false;
              if(ok) {
                log.info("Connected to %s (%s:%s) %s", ip, rack, slot, typeName[type]);
                rv = true;
              }
              else {
                log.error("Connection to %s (%s:%s) failed", ip, rack, slot);
              }
            }
            else {
              this.isConnectOngoing = false;
              log.error("Set connection type to %s (%s:%s) %s failed", ip, rack, slot, typeName[type]);
            }
          }
      }
    return rv;
  }
};


function GenericPLCAccessory(platform, config, accessoryNumber) {
  this.platform = platform;
  this.log = platform.log;
  this.name = config.name;
  var uuid = UUIDGen.generate(config.name + config.accessory);
  this.config = config;
  this.accessory = new PlatformAccessory(this.name, uuid);
  this.modFunctionGet = this.plain;
  this.modFunctionSet = this.plain;

  if ('enablePolling' in platform.config && platform.config.enablePolling && config.enablePolling) {
      this.pollActive = true;
      this.pollInterval =  config.pollInterval || platform.config.defaultPollInterval;
      if (platform.config.distributePolling) {
        this.pollCounter = (accessoryNumber % this.pollInterval) + 1;
      }
      else
      {
        this.pollCounter = this.pollInterval;
      }
      this.log.debug("Polling enabled interval " + this.pollInterval + "s. First polling is done in " + this.pollCounter + "s");
  }

  // INIT handling ///////////////////////////////////////////////
  // Lightbulb, Outlet, Switch
  ////////////////////////////////////////////////////////////////
  if (config.accessory == 'PLC_LightBulb' || config.accessory == 'PLC_Outlet' || config.accessory == 'PLC_Switch') {
    this.service =  new Service.Lightbulb(this.name);

    if (config.accessory == 'PLC_LightBulb')
    {
      this.service = new Service.Lightbulb(this.name);
    }
    else if (config.accessory == 'PLC_Outlet')
    {
      this.service = new Service.Outlet(this.name);
    }
    else
    {
      this.service = new Service.Switch(this.name);
    }

    this.accessory.addService(this.service);
    if ('set_Off' in config) {
      this.service.getCharacteristic(Characteristic.On)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_On), Math.floor((config.get_On*10)%10),
          'get On'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setOnOffBit(powerOn, callback,
          config.db,
          Math.floor(config.set_On), Math.floor((config.set_On*10)%10),
          Math.floor(config.set_Off), Math.floor((config.set_Off*10)%10),
          'set On'
        );}.bind(this));
    } else {
      this.service.getCharacteristic(Characteristic.On)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_On), Math.floor((config.get_On*10)%10),
          'get On'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setBit(powerOn, callback,
          config.db,
          Math.floor(config.set_On), Math.floor((config.set_On*10)%10),
          'set On'
        );}.bind(this));
    }

    if (config.accessory == 'PLC_LightBulb') {
      if ('get_Brightness' in config) {
        this.service.getCharacteristic(Characteristic.Brightness)
        .on('get', function(callback) {this.getByte(callback,
          config.db,
          config.get_Brightness,
          'get Brightness'
          );}.bind(this))
        .on('set', function(value, callback) {this.setByte(value, callback,
          config.db,
          config.set_Brightness,
          'set Brightness'
          );}.bind(this))
          .setProps({
            minValue: ('minValue' in config) ? config.minValue : 20,
            maxValue: ('maxValue' in config) ? config.maxValue : 100,
            minStep: config.minStep || 1
        });
      }
    }
  }

  // INIT handling ///////////////////////////////////////////////
  // TemperatureSensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_TemperatureSensor') {
    this.service =  new Service.TemperatureSensor(this.name);
    this.accessory.addService(this.service);

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
    .on('get', function(callback) {this.getReal(callback,
      config.db,
      config.get_CurrentTemperature,
      'get CurrentTemperature'
      );}.bind(this))
    .setProps({
      minValue: ('minValue' in config) ? config.minValue : -50,
      maxValue: ('maxValue' in config) ? config.maxValue : 110,
      minStep: config.minStep || 0.5
    });

    if ('get_StatusTampered' in config) {
      this.service.getCharacteristic(Characteristic.StatusTampered)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
        'get StatusTampered'
      );}.bind(this));
    }

    if ('get_StatusLowBattery' in config) {
      this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
        'get StatusLowBattery'
      );}.bind(this));
    }
  }

  // INIT handling ///////////////////////////////////////////////
  // HumiditySensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_HumiditySensor') {
    this.service =  new Service.HumiditySensor(this.name);
    this.accessory.addService(this.service);

    this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
    .on('get', function(callback) {this.getReal(callback,
      config.db,
      config.get_CurrentRelativeHumidity,
      'get CurrentRelativeHumidity'
      );}.bind(this))
    .setProps({
      minValue: ('minValue' in config) ? config.minValue : 0,
      maxValue: ('maxValue' in config) ? config.maxValue : 100,
      minStep: config.minStep || 1
    });
    if ('get_StatusTampered' in config) {
      this.service.getCharacteristic(Characteristic.StatusTampered)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
        'get StatusTampered'
      );}.bind(this));
    }

    if ('get_StatusLowBattery' in config) {
      this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
        'get StatusLowBattery'
      );}.bind(this));
    }
  }

  // INIT handling ///////////////////////////////////////////////
  // Thermostat
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_Thermostat'){
    this.service = new Service.Thermostat(this.name);
    this.accessory.addService(this.service);


    informFunction = function(notUsed){
      // update target state and current state value.
      this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(value);
        }
      }.bind(this));

      this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(value);
        }
      }.bind(this));
     }.bind(this);

    if ('mapSetTarget' in config && config.mapSetTarget) {
      this.modFunctionSet = function(value){return this.mapFunction(value, config.mapSetTarget);}.bind(this);
    }

    if ('mapGetTarget' in config && config.mapGetTarget) {
      this.modFunctionGet = function(value){return this.mapFunction(value, config.mapGetTarget);}.bind(this);
    }

    this.modFunctionGetCurrent = this.plain;
    if ('mapGetCurrent' in config && config.mapGetCurrent) {
      this.modFunctionGetCurrent = function(value){return this.mapFunction(value, config.mapGetCurrent);}.bind(this);
    }

    if ('get_CurrentHeatingCoolingState' in config) {
      this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_CurrentHeatingCoolingState,
        'get CurrentHeatingCoolingState',
        this.modFunctionGetCurrent
        );}.bind(this));
    }
    else
    {
      this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', function(callback) {this.getDummy(callback,
        1, // currently return fixed value inactive=0, idle=1, heating=2, cooling=3
        'get CurrentHeatingCoolingState'
        );}.bind(this));
    }

    if ('get_TargetHeatingCoolingState' in config) {
      this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_TargetHeatingCoolingState,
        'get TargetHeatingCoolingState',
        this.modFunctionGet
        );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_TargetHeatingCoolingState,
        'set TargetHeatingCoolingState',
        informFunction,
        this.modFunctionSet
        );}.bind(this));
    }
    else {
      this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', function(callback) {this.getDummy(callback,
        3, // currently return fixed value off=0, heat=1, cool=2, automatic=3
        'get TargetHeatingCoolingState'
        );}.bind(this))
      .on('set', function(value, callback) {this.setDummy(value, callback,
        'set TargetHeatingCoolingState',
        // ignore set and return current fixed values
        informFunction
        );}.bind(this));
    }

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .on('get', function(callback) {this.getDummy(callback,
      0, // currently return fixed value celsius=0, fahrenheit=1
      'get TemperatureDisplayUnits'
      );}.bind(this))
    .on('set', function(value, callback) {this.setDummy(value, callback,
      'set TemperatureDisplayUnits'
      );}.bind(this));

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
    .on('get', function(callback) {this.getReal(callback,
      config.db,
      config.get_CurrentTemperature,
      'get CurrentTemperature'
      );}.bind(this));

    this.service.getCharacteristic(Characteristic.TargetTemperature)
    .on('get', function(callback) {this.getReal(callback,
      config.db,
      config.get_TargetTemperature,
      'get TargetTemperature'
      );}.bind(this))
    .on('set', function(value, callback) {this.setReal(value, callback,
      config.db,
      config.set_TargetTemperature,
      'set TargetTemperature'
      );}.bind(this))
      .setProps({
        minValue: ('minValue' in config) ? config.minValue : 15,
        maxValue: ('maxValue' in config) ? config.maxValue : 27,
        minStep: config.minStep || 0.5
    });

    if ('get_CurrentRelativeHumidity' in config) {
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_CurrentRelativeHumidity,
        'get CurrentRelativeHumidity'
        );}.bind(this))
    }
    if ('get_TargetRelativeHumidity' in config) {
      this.service.getCharacteristic(Characteristic.TargetRelativeHumidity)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_TargetRelativeHumidity,
        'get TargetRelativeHumidity'
        );}.bind(this))
      .on('set', function(value, callback) {this.setReal(value, callback,
        config.db,
        config.set_TargetRelativeHumidity,
        'set TargetRelativeHumidity'
        );}.bind(this))
        .setProps({
          minValue: ('minHumidityValue' in config) ? config.minValue : 0,
          maxValue: ('maxHumidityValue' in config) ? config.maxValue : 100,
          minStep: config.minHumidityStep || 1
      });
    }

    if ('get_StatusTampered' in config) {
      //This will generate a warning but will work anyway.
      this.service.getCharacteristic(Characteristic.StatusTampered)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
        'get StatusTampered'
      );}.bind(this));
    }

    if ('get_StatusLowBattery' in config) {
      //This will generate a warning but will work anyway.
      this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
        'get StatusLowBattery'
      );}.bind(this));
    }

  }
  // INIT handling ///////////////////////////////////////////////
  // Humidifier Dehumidifier
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_HumidifierDehumidifier'){
    this.service = new Service.HumidifierDehumidifier(this.name);
    this.accessory.addService(this.service);

    informFunction = function(notUsed){
      // update target state and current state value.
      this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).updateValue(value);
        }
      }.bind(this));

      this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).updateValue(value);
        }
      }.bind(this));
     }.bind(this);

    if ('mapSetTarget' in config && config.mapSetTarget) {
      this.modFunctionSet = function(value){return this.mapFunction(value, config.mapSetTarget);}.bind(this);
    }

    if ('mapGetTarget' in config && config.mapGetTarget) {
      this.modFunctionGet = function(value){return this.mapFunction(value, config.mapGetTarget);}.bind(this);
    }

    this.modFunctionGetCurrent = this.plain;
    if ('mapGetCurrent' in config && config.mapGetCurrent) {
      this.modFunctionGetCurrent = function(value){return this.mapFunction(value, config.mapGetCurrent);}.bind(this);
    }

    if ('get_CurrentHumidifierDehumidifierState' in config) {
      this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_CurrentHumidifierDehumidifierState,
        'get CurrentHumidifierDehumidifierState',
        this.modFunctionGetCurrent
        );}.bind(this));
    }
    else
    {
      this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
      .on('get', function(callback) {this.getDummy(callback,
        1, // currently return fixed value inactive=0, idle=1, humidifying=2, dehumidifying=3
        'get CurrentHumidifierDehumidifierState'
        );}.bind(this));
    }

    if ('get_TargetHumidifierDehumidifierState' in config) {
      this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_TargetHumidifierDehumidifierState,
        'get TargetHumidifierDehumidifierState',
        this.modFunctionGet
        );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_TargetHumidifierDehumidifierState,
        'set TargetHumidifierDehumidifierState',
        informFunction,
        this.modFunctionSet
        );}.bind(this));
    }
    else {
      this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .on('get', function(callback) {this.getDummy(callback,
        config.default_TargetHumidifierDehumidifierState || 0, // currently return fixed value auto=0, humidifier=1, dehumidifier=2
        'get TargetHeatingCoolingState'
        );}.bind(this))
      .on('set', function(value, callback) {this.setDummy(value, callback,
        'set TargetHeatingCoolingState',
        // ignore set and return current fixed values
        informFunction
        );}.bind(this));
    }

    this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
    .on('get', function(callback) {this.getReal(callback,
      config.db,
      config.get_CurrentRelativeHumidity,
      'get CurrentRelativeHumidity'
      );}.bind(this));

    if ('get_RelativeHumidityDehumidifierThreshold' in config) {
      this.service.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_RelativeHumidityDehumidifierThreshold,
        'get RelativeHumidityDehumidifierThreshold'
        );}.bind(this))
      .on('set', function(value, callback) {this.setReal(value, callback,
        config.db,
        config.set_RelativeHumidityDehumidifierThreshold,
        'set RelativeHumidityDehumidifierThreshold'
        );}.bind(this));
    }

    if ('get_RelativeHumidityHumidifierThreshold' in config) {
      this.service.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_RelativeHumidityHumidifierThreshold,
        'get RelativeHumidityHumidifierThreshold'
        );}.bind(this))
      .on('set', function(value, callback) {this.setReal(value, callback,
        config.db,
        config.set_RelativeHumidityHumidifierThreshold,
        'set RelativeHumidityHumidifierThreshold'
        );}.bind(this));
    }

    if ('get_RotationSpeed' in config) {
      this.service.getCharacteristic(Characteristic.RotationSpeed)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_RotationSpeed,
        'get RotationSpeed'
        );}.bind(this))
      .on('set', function(value, callback) {this.setReal(value, callback,
        config.db,
        config.set_RotationSpeed,
        'set RotationSpeed'
        );}.bind(this));
    }else if ('get_RotationSpeedByte' in config) {
      this.service.getCharacteristic(Characteristic.RotationSpeed)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_RotationSpeedByte,
        'get RotationSpeed'
        );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_RotationSpeedByte,
        'set RotationSpeed'
        );}.bind(this));
    }

    if ('set_Deactivate' in config) {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setOnOffBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          Math.floor(config.set_Deactivate), Math.floor((config.set_Deactivate*10)%10),
          'set Active'
        );}.bind(this));
    } else if ('get_Active' in config) {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          'set Active'
        );}.bind(this));
    } else {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getDummy(callback,
          1,
          'get Active'
        );}.bind(this))
        .on('set', function(value, callback) { this.setDummy(value, callback,
          'set Active',
          function(value){this.service.getCharacteristic(Characteristic.Active).updateValue(value);}.bind(this)
        );}.bind(this));
      }

    if ('get_SwingMode' in config) {
      this.service.getCharacteristic(Characteristic.SwingMode)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_SwingMode,
        'get SwingMode'
        );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_SwingMode,
        'set SwingMode'
        );}.bind(this));
    }

    if ('get_WaterLevel' in config) {
      this.service.getCharacteristic(Characteristic.WaterLevel)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_WaterLevel,
        'get WaterLevel'
        );}.bind(this));
    }

    if ('get_StatusTampered' in config) {
      //This will generate a warning but will work anyway.
      this.service.getCharacteristic(Characteristic.StatusTampered)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
        'get StatusTampered'
      );}.bind(this));
    }

    if ('get_StatusLowBattery' in config) {
      //This will generate a warning but will work anyway.
      this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
        'get StatusLowBattery'
      );}.bind(this));
    }

  }
  // INIT handling ///////////////////////////////////////////////
  // Window, WindowCovering and Door
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_Window' || config.accessory == 'PLC_WindowCovering' || config.accessory == 'PLC_Door'){
    if (config.accessory == 'PLC_Window')
    {
      this.service = new Service.Window(this.name);
    }
    else if (config.accessory == 'PLC_WindowCovering')
    {
      this.service = new Service.WindowCovering(this.name);
    }
    else
    {
      this.service = new Service.Door(this.name);
    }
    this.accessory.addService(this.service);
    this.lastTargetPos = 0;

    // default do nothing after set of target position
    var informFunction = function(value){}.bind(this);

    if ('forceCurrentPosition' in config && config.forceCurrentPosition) {
      informFunction = function(value){this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(value);}.bind(this);
    }

    if ('enablePolling' in platform.config && platform.config.enablePolling) {
        if ('adaptivePolling' in config && config.adaptivePolling) {
          // high frequency polling during home app tirggerd movement
          this.adaptivePollActive = false;
          this.adaptivePollingInterval =  config.adaptivePollingInterval || 1;
          this.pollCounter = this.adaptivePollingInterval;
          this.log.debug("Adaptive polling enabled interval " + this.adaptivePollingInterval + "s");
          // When execution set save target position and enable polling with high frequency
          informFunction = function(value){ this.lastTargetPos = value; this.pollCounter = this.adaptivePollingInterval; this.adaptivePollActive = true; }.bind(this);
        }
    }

    if ('invert' in config && config.invert) {
      this.modFunctionGet = this.invert_0_100;
      this.modFunctionSet = this.invert_0_100;
    }

    if ('mapGet' in config && config.mapGet) {
      this.modFunctionGet = function(value){return this.mapFunction(value, config.mapGet);}.bind(this);
    }

    // create handlers for required characteristics
    this.service.getCharacteristic(Characteristic.CurrentPosition)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_CurrentPosition,
        'get CurrentPosition',
        this.modFunctionGet
        );}.bind(this));

    if ('get_TargetPosition' in config) {
      // Windows or WindowCover can be electrically moved
      this.service.getCharacteristic(Characteristic.TargetPosition)
        .on('get', function(callback) {this.getByte(callback,
          config.db,
          config.get_TargetPosition,
          'get TargetPosition',
          this.modFunctionGet
          );}.bind(this))
        .on('set', function(value, callback) {this.setByte(value, callback,
          config.db,
          config.set_TargetPosition,
          'set TargetPosition',
          informFunction,
          this.modFunctionSet
          );}.bind(this));
    }
    else
    {
      // Not possible give a target position always use current position as target position.
      this.service.getCharacteristic(Characteristic.TargetPosition)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_CurrentPosition,  // always use current position as target position
        'get CurrentPosition',
        this.modFunctionGet
        );}.bind(this))
      .on('set', function(value, callback) {this.setDummy(value, callback,
        'set TargetPosition',
        function(value){
          // ignore new target value instead get current value and use it target position
          this.service.getCharacteristic(Characteristic.CurrentPosition).getValue(function(err, value) {
            if (!err) {
              this.service.getCharacteristic(Characteristic.TargetPosition).updateValue(value);
            }
          }.bind(this));
          }.bind(this)
        );}.bind(this));
    }
    if ('get_PositionState' in config) {
      this.service.getCharacteristic(Characteristic.PositionState)
        .on('get', function(callback) {this.getByte(callback,
          config.db,
          config.get_PositionState,
          'get PositionState'
        );}.bind(this));
    }
    else {
      this.service.getCharacteristic(Characteristic.PositionState)
        .on('get', function(callback) {this.getDummy(callback,
        2,
        'get PositionState'
        );}.bind(this));
        }

    if ('set_HoldPosition' in config) {
    this.service.getCharacteristic(Characteristic.HoldPosition)
      .on('set', function(value, callback) { this.setBit(value, callback,
        config.db,
        Math.floor(config.set_HoldPosition), Math.floor((config.set_HoldPosition*10)%10),
        'set HoldPosition'
        );}.bind(this));
    }
    else {
      this.service.getCharacteristic(Characteristic.HoldPosition)
        .on('set', function(callback) {this.handleDummy(callback,
          'set HoldPosition'
          );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // OccupancySensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_OccupancySensor'){
    this.service = new Service.OccupancySensor(this.name);
    this.accessory.addService(this.service);

    if ('invert' in config && config.invert) {
        this.modFunctionGet = this.invert_bit;
    }

    this.service.getCharacteristic(Characteristic.OccupancyDetected)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_OccupancyDetected), Math.floor((config.get_OccupancyDetected*10)%10),
        "get OccupancyDetected",
        this.modFunctionGet
      );}.bind(this));

      if ('get_StatusTampered' in config) {
        this.service.getCharacteristic(Characteristic.StatusTampered)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
          'get StatusTampered'
        );}.bind(this));
      }

      if ('get_StatusLowBattery' in config) {
        this.service.getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
          'get StatusLowBattery'
        );}.bind(this));
      }
  }
  // INIT handling ///////////////////////////////////////////////
  // MotionSensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_MotionSensor'){
    this.service = new Service.MotionSensor(this.name);
    this.accessory.addService(this.service);

    if ('invert' in config && config.invert) {
        this.modFunctionGet = this.invert_bit;
    }

    this.service.getCharacteristic(Characteristic.MotionDetected)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_MotionDetected), Math.floor((config.get_MotionDetected*10)%10),
        "get MotionDetected",
        this.modFunctionGet
      );}.bind(this));

      if ('get_StatusTampered' in config) {
        this.service.getCharacteristic(Characteristic.StatusTampered)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
          'get StatusTampered'
        );}.bind(this));
      }

      if ('get_StatusLowBattery' in config) {
        this.service.getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
          'get StatusLowBattery'
        );}.bind(this));
      }
  }
  // INIT handling ///////////////////////////////////////////////
  // ContactSensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_ContactSensor'){
    this.service = new Service.ContactSensor(this.name);
    this.accessory.addService(this.service);

    if ('invert' in config && config.invert) {
        this.modFunctionGet = this.invert_bit;
    }

      this.service.getCharacteristic(Characteristic.ContactSensorState)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_ContactSensorState), Math.floor((config.get_ContactSensorState*10)%10),
        "get get_ContactSensorState",
        this.modFunctionGet
      );}.bind(this));

      if ('get_StatusTampered' in config) {
        this.service.getCharacteristic(Characteristic.StatusTampered)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
          'get StatusTampered'
        );}.bind(this));
      }

      if ('get_StatusLowBattery' in config) {
        this.service.getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
          'get StatusLowBattery'
        );}.bind(this));
      }
  }
  // INIT handling ///////////////////////////////////////////////
  // LeakSensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_LeakSensor'){
    this.service = new Service.LeakSensor(this.name);
    this.accessory.addService(this.service);

    if ('invert' in config && config.invert) {
        this.modFunctionGet = this.invert_bit;
    }

      this.service.getCharacteristic(Characteristic.LeakDetected)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_LeakDetected), Math.floor((config.get_LeakDetected*10)%10),
        "get LeakDetected",
        this.modFunctionGet
      );}.bind(this));

      if ('get_StatusTampered' in config) {
        this.service.getCharacteristic(Characteristic.StatusTampered)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
          'get StatusTampered'
        );}.bind(this));
      }

      if ('get_StatusLowBattery' in config) {
        this.service.getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
          'get StatusLowBattery'
        );}.bind(this));
      }
  }
  // INIT handling ///////////////////////////////////////////////
  // Faucet
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_Faucet'){
    this.service =  new Service.Faucet(this.name);
    this.accessory.addService(this.service);

    if ('set_Deactivate' in config) {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setOnOffBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          Math.floor(config.set_Deactivate), Math.floor((config.set_Deactivate*10)%10),
          'set Active'
        );}.bind(this));
    } else {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          'set Active'
        );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // Valve
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_Valve'){
    this.service = new Service.Valve(this.name);
    this.accessory.addService(this.service);

    if ('set_Deactivate' in config) {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setOnOffBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          Math.floor(config.set_Deactivate), Math.floor((config.set_Deactivate*10)%10),
          'set Active',
          function(value){this.service.getCharacteristic(Characteristic.InUse).updateValue(value);}.bind(this)
        );}.bind(this));
    } else {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          'set Active',
          function(value){this.service.getCharacteristic(Characteristic.InUse).updateValue(value);}.bind(this)
        );}.bind(this));
    }

    this.service.getCharacteristic(Characteristic.InUse)
    .on('get', function(callback) {this.getBit(callback,
      config.db,
      Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
      'get InUse'
    );}.bind(this));

    if ('ValveType' in config) {
      this.service.getCharacteristic(Characteristic.ValveType)
        .on('get', function(callback) {this.getDummy(callback,
        config.ValveType,
        'get ValveType'
        );}.bind(this));
    }

    if ('get_RemainingDuration' in config) {
      this.service.getCharacteristic(Characteristic.RemainingDuration)
        .on('get', function(callback) {this.getDInt(callback,
          config.db,
          config.get_RemainingDuration,
          "get RemainingDuration",
          this.s7time2int
        );}.bind(this));

        this.service.getCharacteristic(Characteristic.SetDuration)
        .on('get', function(callback) {this.getDInt(callback,
          config.db,
          config.get_SetDuration,
          "get SetDuration",
          this.s7time2int
        );}.bind(this))
        .on('set', function(value, callback) {this.setDInt(value, callback,
          config.db,
          config.set_SetDuration,
          "set SetDuration",
          function(value){this.service.getCharacteristic(Characteristic.RemainingDuration).updateValue(value);}.bind(this),
          this.int27time
        );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // SecuritySystem
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_SecuritySystem'){
    this.service = new Service.SecuritySystem(this.name);
    this.accessory.addService(this.service);
    this.modFunctionGetCurrent = this.plain;

    informFunction = function(notUsed){
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(value);
        }
      }.bind(this));
      // get the current system state and update the value.
      this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(value);
        }
      }.bind(this));
     }.bind(this);

    if ('mapSet' in config && config.mapSet) {
      this.modFunctionSet = function(value){return this.mapFunction(value, config.mapSet);}.bind(this);
    }
    else if ('mapSetTarget' in config && config.mapSetTarget) {
      this.modFunctionSet = function(value){return this.mapFunction(value, config.mapSetTarget);}.bind(this);
    }

    if ('mapGet' in config && config.mapGet) {
      this.modFunctionGet = function(value){return this.mapFunction(value, config.mapGet);}.bind(this);
      this.modFunctionGetCurrent = function(value){return this.mapFunction(value, config.mapGet);}.bind(this);
    }
    else {
      if ('mapGetTarget' in config && config.mapGetTarget) {
        this.modFunctionGet = function(value){return this.mapFunction(value, config.mapGetTarget);}.bind(this);
      }

      if ('mapGetCurrent' in config && config.mapGetCurrent) {
        this.modFunctionGetCurrent = function(value){return this.mapFunction(value, config.mapGetCurrent);}.bind(this);
      }
    }

    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_SecuritySystemCurrentState,
        "get SecuritySystemCurrentState",
        this.modFunctionGetCurrent
      );}.bind(this));

      this.service.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_SecuritySystemTargetState,
        "get SecuritySystemTargetState",
        this.modFunctionGet
      );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_SecuritySystemTargetState,
        "set SecuritySystemTargetState",
        informFunction,
        this.modFunctionSet
      );}.bind(this));
  }
  // INIT handling ///////////////////////////////////////////////
  // StatelessProgrammableSwitch, Doorbell
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_StatelessProgrammableSwitch' || config.accessory == 'PLC_Doorbell'){

    if (config.accessory == 'PLC_StatelessProgrammableSwitch' ){
      this.service = new Service.StatelessProgrammableSwitch(this.name);
    }
    else {
      this.service = new Service.Doorbell(this.name);
    }
    this.accessory.addService(this.service);

    this.service.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_ProgrammableSwitchEvent,
        "get ProgrammableSwitchEvent"
      );}.bind(this));

    if (config.accessory == 'PLC_StatelessProgrammableSwitch' ){
      this.service.getCharacteristic(Characteristic.ServiceLabelIndex)
      .on('get', function(callback) {this.getDummy(callback,
        1,
        "get ServiceLabelIndex"
      );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // LockMechanism
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_LockMechanism'){
    this.service = new Service.LockMechanism(this.name);
    this.accessory.addService(this.service);

    if ('forceCurrentState' in config && config.forceCurrentState) {
      informFunction = function(value){this.service.getCharacteristic(Characteristic.LockCurrentState).updateValue(value);}.bind(this);
    }

    if ('mapSet' in config && config.mapSet) {
      this.modFunctionSet = function(value){return this.mapFunction(value, config.mapSet);}.bind(this);
    }

    if ('mapGet' in config && config.mapGet) {
      this.modFunctionGet = function(value){return this.mapFunction(value, config.mapGet);}.bind(this);
    }

    this.service.getCharacteristic(Characteristic.LockCurrentState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_LockCurrentState,
        "get LockCurrentState",
        this.modFunctionGet
      );}.bind(this));

      this.service.getCharacteristic(Characteristic.LockTargetState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_LockTargetState,
        "get LockTargetState",
        this.modFunctionGet
      );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_LockTargetState,
        "set LockTargetState",
        informFunction,
        this.modFunctionSet
      );}.bind(this));
  }
  // INIT handling ///////////////////////////////////////////////
  // LockMechanismBool
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_LockMechanismBool'){
    this.service = new Service.LockMechanism(this.name);
    this.accessory.addService(this.service);

    if ('forceCurrentState' in config && config.forceCurrentState) {
      informFunction = function(value){this.service.getCharacteristic(Characteristic.LockCurrentState).updateValue(value);}.bind(this);
    }

    // note the invert is inverted! To invert is normal behaviour.
    if (!('invert' in config && config.invert)) {
      this.modFunctionGet = this.invert_bit;
      this.modFunctionSet = this.invert_bit;
    }

    this.service.getCharacteristic(Characteristic.LockCurrentState)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_LockCurrentState), Math.floor((config.get_LockCurrentState*10)%10),
        "get LockCurrentState",
        this.modFunctionGet
      );}.bind(this));

    if ('set_Unsecured' in config) {
      this.service.getCharacteristic(Characteristic.LockTargetState)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_LockTargetState), Math.floor((config.get_LockTargetState*10)%10),
        "get LockTargetState",
        this.modFunctionGet
      );}.bind(this))
      .on('set', function(value, callback) { this.setOnOffBit(value, callback,
        config.db,
        Math.floor(config.set_Secured), Math.floor((config.set_Secured*10)%10),
        Math.floor(config.set_Unsecured), Math.floor((config.set_Unsecured*10)%10),
        'set LockTargetState',
        informFunction
      );}.bind(this));
    } else {
      this.service.getCharacteristic(Characteristic.LockTargetState)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_LockTargetState), Math.floor((config.get_LockTargetState*10)%10),
        "get LockTargetState",
        this.modFunctionGet
      );}.bind(this))
      .on('set', function(value, callback) {this.setBit(value, callback,
        config.db,
        Math.floor(config.set_LockTargetState), Math.floor((config.set_LockTargetState*10)%10),
        "set LockTargetState",
        informFunction,
        this.modFunctionSet
      );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // PLC_GarageDoorOpener
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_GarageDoorOpener'){
    this.service = new Service.GarageDoorOpener(this.name);
    this.accessory.addService(this.service);

    if ('forceCurrentState' in config && config.forceCurrentState) {
      informFunction = function(value){this.service.getCharacteristic(Characteristic.CurrentDoorState).updateValue(value);}.bind(this);
    }
    this.service.getCharacteristic(Characteristic.CurrentDoorState)
    .on('get', function(callback) {this.getByte(callback,
      config.db,
      config.get_CurrentDoorState,
      "get CurrentDoorState"
    );}.bind(this)) ;

    this.service.getCharacteristic(Characteristic.TargetDoorState)
    .on('get', function(callback) {this.getByte(callback,
      config.db,
      config.get_TargetDoorState,
      "get TargetDoorState"
    );}.bind(this))
    .on('set', function(value, callback) {this.setByte(value, callback,
      config.db,
      config.set_TargetDoorState,
      "set TargetDoorState",
      informFunction
      );}.bind(this));

    if ('get_ObstructionDetected' in config) {
      this.service.getCharacteristic(Characteristic.ObstructionDetected)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_ObstructionDetected), Math.floor((config.get_ObstructionDetected*10)%10),
        'get ObstructionDetected'
      );}.bind(this));
    }
    else{
      this.service.getCharacteristic(Characteristic.ObstructionDetected)
      .on('get', function(callback) {this.getDummy(callback,
        0,
        'get ObstructionDetected'
      );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // SmokeSensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_SmokeSensor'){
    this.service = new Service.SmokeSensor(this.name);
    this.accessory.addService(this.service);

    this.service.getCharacteristic(Characteristic.SmokeDetected)
    .on('get', function(callback) {this.getBit(callback,
      config.db,
      Math.floor(config.get_SmokeDetected), Math.floor((config.get_SmokeDetected*10)%10),
      'get SmokeDetected'
    );}.bind(this));

    if ('get_StatusTampered' in config) {
      this.service.getCharacteristic(Characteristic.StatusTampered)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
        'get StatusTampered'
      );}.bind(this));
    }

    if ('get_StatusLowBattery' in config) {
      this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
        'get StatusLowBattery'
      );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // Fan
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_Fan'){
    this.service =  new Service.Fanv2(this.name);
    this.accessory.addService(this.service);
    this.modDirectionGet = this.plain;
    this.modDirectionSet = this.plain;
    this.modTargetSet = this.plain;
    this.modCurrentGet = this.plain;
    this.modFunctionGetCurrent = this.plain;

    var dummyInform = function(value){}.bind(this);

    var informFunction = function(notUsed){
      // update target state and current state value.
      this.service.getCharacteristic(Characteristic.TargetFanState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetFanState).updateValue(value);
        }
      }.bind(this));

      this.service.getCharacteristic(Characteristic.CurrentFanState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentFanState).updateValue(value);
        }
      }.bind(this));
     }.bind(this);

    if ('mapCurrentGet' in config && config.mapCurrentGet) {
      this.modCurrentGet = function(value){return this.mapFunction(value, config.mapCurrentGet);}.bind(this);
    }
    if ('mapTargetSet' in config && config.mapTargetSet) {
      this.modTargetSet = function(value){return this.mapFunction(value, config.mapTargetSet);}.bind(this);
    }
    if ('mapTargetGet' in config && config.mapTargetGet) {
      this.modTargetGet = function(value){return this.mapFunction(value, config.mapTargetGet);}.bind(this);
    }
    if ('mapDirectionGet' in config && config.mapDirectionGet) {
      this.modDirectionGet = function(value){return this.mapFunction(value, config.mapDirectionGet);}.bind(this);
    }
    if ('mapDirectionSet' in config && config.mapDirectionSet) {
      this.modDirectionSet = function(value){return this.mapFunction(value, config.mapDirectionSet);}.bind(this);
    }

    if ('get_TargetFanState' in config) {
      this.service.getCharacteristic(Characteristic.TargetFanState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_TargetFanState,
        'get TargetFanState',
        this.modTargetGet
        );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_TargetFanState,
        'set TargetFanState',
        informFunction,
        this.mapTargetSet
        );}.bind(this));
    }
    else if ('default_TargetFanState' in config) {
      this.service.getCharacteristic(Characteristic.TargetFanState)
      .on('get', function(callback) {this.getDummy(callback,
        config.default_TargetFanState || 0, // currently return fixed value inactive=0, idle=1, blowing=2
        'get TargetFanState'
        );}.bind(this))
      .on('set', function(value, callback) {this.setDummy(value, callback,
        'set TargetFanState',
        // ignore set and return current fixed values
        informFunction
        );}.bind(this));
    }

    if ('get_CurrentFanState' in config) {
      this.service.getCharacteristic(Characteristic.CurrentFanState)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_CurrentFanState,
        'get CurrentFanState',
        this.modFunctionGetCurrent
        );}.bind(this));
    }
    else if ('default_CurrentFanState' in config) {
      this.service.getCharacteristic(Characteristic.CurrentFanState)
      .on('get', function(callback) {this.getDummy(callback,
        config.default_CurrentFanState,
        'get CurrentFanState'
        );}.bind(this));
    }

    if ('set_Deactivate' in config) {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setOnOffBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          Math.floor(config.set_Deactivate), Math.floor((config.set_Deactivate*10)%10),
          'set Active'
        );}.bind(this));
    } else {
      this.service.getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {this.getBit(callback,
          config.db,
          Math.floor(config.get_Active), Math.floor((config.get_Active*10)%10),
          'get Active'
        );}.bind(this))
        .on('set', function(powerOn, callback) { this.setBit(powerOn, callback,
          config.db,
          Math.floor(config.set_Active), Math.floor((config.set_Active*10)%10),
          'set Active'
        );}.bind(this));
    }

    if ('get_RotationSpeed' in config) {
      this.service.getCharacteristic(Characteristic.RotationSpeed)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_RotationSpeed,
        'get RotationSpeed'
        );}.bind(this))
      .on('set', function(value, callback) {this.setReal(value, callback,
        config.db,
        config.set_RotationSpeed,
        'set RotationSpeed'
        );}.bind(this));
    } else if ('get_RotationSpeedByte' in config) {
      this.service.getCharacteristic(Characteristic.RotationSpeed)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_RotationSpeedByte,
        'get RotationSpeed'
        );}.bind(this))
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_RotationSpeedByte,
        'set RotationSpeed'
        );}.bind(this));
    }

    if ('get_RotationDirection' in config) {
      this.service.getCharacteristic(Characteristic.RotationDirection)
      .on('get', function(callback) {this.getByte(callback,
        config.db,
        config.get_RotationDirection,
        'get RotationDirection',
        this.modDirectionGet
        );}.bind(this));
    }
    if ('set_RotationDirection' in config) {
      this.service.getCharacteristic(Characteristic.RotationDirection)
      .on('set', function(value, callback) {this.setByte(value, callback,
        config.db,
        config.set_RotationDirection,
        'set RotationDirection',
        dummyInform,
        this.modDirectionSet
        );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // LightSensor
  ////////////////////////////////////////////////////////////////
  else if (config.accessory == 'PLC_LightSensor'){
    this.service = new Service.LightSensor(this.name);
    this.accessory.addService(this.service);

    this.modFunctionGet = function(value){return this.limitFunction(value, 0.0001 ,100000);}.bind(this);

    if ('get_CurrentAmbientLightLevelDInt' in config) {
      this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .on('get', function(callback) {this.getDInt(callback,
        config.db,
        config.get_CurrentAmbientLightLevelDInt,
        "get CurrentAmbientLightLevel",
        this.modFunctionGet
      );}.bind(this));
    }else{
      this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .on('get', function(callback) {this.getReal(callback,
        config.db,
        config.get_CurrentAmbientLightLevel,
        "get CurrentAmbientLightLevel",
        this.modFunctionGet
      );}.bind(this));
    }

    if ('get_StatusTampered' in config) {
      this.service.getCharacteristic(Characteristic.StatusTampered)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusTampered), Math.floor((config.get_StatusTampered*10)%10),
        'get StatusTampered'
      );}.bind(this));
    }

    if ('get_StatusLowBattery' in config) {
      this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', function(callback) {this.getBit(callback,
        config.db,
        Math.floor(config.get_StatusLowBattery), Math.floor((config.get_StatusLowBattery*10)%10),
        'get StatusLowBattery'
      );}.bind(this));
    }
  }
  // INIT handling ///////////////////////////////////////////////
  // Undefined
  ////////////////////////////////////////////////////////////////
  else {
    this.log.info("Accessory "+ config.accessory + " is not defined.");
  }

  this.accessory.getService(Service.AccessoryInformation)
  .setCharacteristic(Characteristic.Manufacturer, ('manufacturer' in config) ? config.manufacturer : ('db' in config) ? 'homebridge-plc (DB' + String(config.db)+ ')' : 'homebridge-plc')
  .setCharacteristic(Characteristic.Model, config.accessory)
  .setCharacteristic(Characteristic.SerialNumber, uuid)
  .setCharacteristic(Characteristic.FirmwareRevision, '0.0.1');

  //this.log.debug("Done " + this.service.displayName + " (" + this.service.subtype + ") " + this.service.UUID);
}

GenericPLCAccessory.prototype = {

  poll: function() {
    if (this.config.enablePolling || this.config.adaptivePolling) {
      if ((this.pollActive || this.adaptivePollActive  ) && --this.pollCounter <= 0)
      {
        this.pollCounter = this.pollInterval;
        this.log.debug("[" + this.name + "] Execute polling...");
        this.updatePoll();
      }
    }
  },

  ////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////
  // PUSH handling
  ////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////
  updatePush: function(offset, value)
  {
    var rv = false;
    //this.log.debug("["+ this.name +"] ("+ this.config.accessory +") Received updatePush offset:" + offset + " value:" + value);

    // PUSH handling ///////////////////////////////////////////////
    // Lightbulb, Outlet, Switch
    ////////////////////////////////////////////////////////////////
    if (this.config.accessory == 'PLC_LightBulb' ||
        this.config.accessory == 'PLC_Outlet' ||
        this.config.accessory == 'PLC_Switch') {
      if (this.config.get_On == offset)
      {
        this.log.debug( "[" + this.name + "] Push On:" + value);
        this.service.getCharacteristic(Characteristic.On).updateValue(value);
        rv = true;
      }
      if (this.config.accessory == 'PLC_LightBulb' && this.config.get_Brightness == offset)
      {
        this.log.debug( "[" + this.name + "] Push Brightness:" + value);
        this.service.getCharacteristic(Characteristic.Brightness).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // TemperatureSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_TemperatureSensor'){
      if (this.config.get_CurrentTemperature == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentTemperature:" + value);
        this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // HumiditySensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_HumiditySensor'){
      if (this.config.get_CurrentRelativeHumidity == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentRelativeHumidity:" + value);
        this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // Thermostat
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Thermostat'){
      if (this.config.get_CurrentTemperature == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentTemperature :" + value);
        this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(value);
        rv = true;
      }
      if (this.config.get_TargetTemperature == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetTemperature:" + value);
        this.service.getCharacteristic(Characteristic.TargetTemperature).updateValue(value);
        rv = true;
      }
      if (this.config.get_CurrentRelativeHumidity == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentRelativeHumidity:" + value);
        this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
        rv = true;
      }
      if (this.config.get_TargetRelativeHumidity == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetRelativeHumidity:" + value);
        this.service.getCharacteristic(Characteristic.TargetRelativeHumidity).updateValue(value);
        rv = true;
      }
      if (this.config.get_CurrentHeatingCoolingState == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentHeatingCoolingState:" + String(this.modFunctionGetCurrent(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this.modFunctionGetCurrent(parseInt(value)));
        rv = true;
      }
      if (this.config.get_TargetHeatingCoolingState == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetHeatingCoolingState:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // Humidifier Dehumidifier
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_HumidifierDehumidifier'){
      if (this.config.get_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Push Active :" + value);
        this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        rv = true;
      }
      if (this.config.get_CurrentHumidifierDehumidifierState == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentHumidifierDehumidifierState:" + String(this.modFunctionGetCurrent(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).updateValue(this.modFunctionGetCurrent(parseInt(value)));
        rv = true;
      }
      if (this.config.get_TargetHumidifierDehumidifierState == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetHumidifierDehumidifierState:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_CurrentRelativeHumidity == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentRelativeHumidity:" + value);
        this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
        rv = true;
      }
      if (this.config.get_RelativeHumidityDehumidifierThreshold == offset)
      {
        this.log.debug( "[" + this.name + "] Push RelativeHumidityDehumidifierThreshold:" + value);
        this.service.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold).updateValue(value);
        rv = true;
      }
      if (this.config.get_RelativeHumidityHumidifierThreshold == offset)
      {
        this.log.debug( "[" + this.name + "] Push RelativeHumidityHumidifierThreshold:" + value);
        this.service.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold).updateValue(value);
        rv = true;
      }
      if (this.config.get_RotationSpeed == offset || this.config.get_RotationSpeedByte)
      {
        this.log.debug( "[" + this.name + "] Push RotationSpeed:" + value);
        this.service.getCharacteristic(Characteristic.RotationSpeed).updateValue(value);
        rv = true;
      }
      if (this.config.get_SwingMode == offset)
      {
        this.log.debug( "[" + this.name + "] Push SwingMode:" + value);
        this.service.getCharacteristic(Characteristic.SwingMode).updateValue(value);
        rv = true;
      }
      if (this.config.get_WaterLevel == offset)
      {
        this.log.debug( "[" + this.name + "] Push WaterLevel:" + value);
        this.service.getCharacteristic(Characteristic.WaterLevel).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // Window, WindowCovering and Door
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Window' || this.config.accessory == 'PLC_WindowCovering' || this.config.accessory == 'PLC_Door'){
      var has_get_TargetPosition = ('get_TargetPosition' in this.config);
      if (this.config.get_CurrentPosition == offset)
      {
        if(!has_get_TargetPosition) {
          this.log.debug( "[" + this.name + "] Push TargetPosition:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
          this.service.getCharacteristic(Characteristic.TargetPosition).updateValue(this.modFunctionGet(parseInt(value)));
        }
        this.log.debug( "[" + this.name + "] Push CurrentPosition:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if ( this.config.get_TargetPosition == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetPosition:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.TargetPosition).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_PositionState == offset)
      {
        this.log.debug( "[" + this.name + "] Push PositionState:" + value);
        this.service.getCharacteristic(Characteristic.PositionState).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // OccupancySensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_OccupancySensor'){
      if (this.config.get_OccupancyDetected == offset)
      {
        this.log.debug( "[" + this.name + "] Push OccupancyDetected:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // MotionSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_MotionSensor'){
      if (this.config.get_MotionDetected == offset)
      {
        this.log.debug( "[" + this.name + "] Push MotionDetected:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.MotionDetected).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // ContactSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_ContactSensor'){
      if (this.config.get_ContactSensorState == offset)
      {
        this.log.debug( "[" + this.name + "] Push ContactSensorState:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // LeakSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LeakSensor'){
      if (this.config.get_LeakDetected == offset)
      {
        this.log.debug( "[" + this.name + "] Push LeakDetected:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.LeakDetected).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // Faucet
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Faucet'){
      if (this.config.get_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Push Active:" + value);
        this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // Valve
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Valve'){
      if (this.config.get_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Push Active:" + value);
        this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        rv = true;
      }
      if (this.config.get_SetDuration == offset)
      {
        this.log.debug( "[" + this.name + "] Push SetDuration:" + value);
        this.service.getCharacteristic(Characteristic.SetDuration).updateValue(value);
        rv = true;
      }
      if (this.config.get_RemainingDuration == offset)
      {
        this.log.debug( "[" + this.name + "] Push RemainingDuration:" + value);
        this.service.getCharacteristic(Characteristic.RemainingDuration).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // SecuritySystem
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_SecuritySystem'){
      if (this.config.get_SecuritySystemCurrentState == offset)
      {
        this.log.debug( "[" + this.name + "] Push SecuritySystemCurrentState:" + String(this.modFunctionGetCurrent(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(this.modFunctionGetCurrent(parseInt(value)));
        rv = true;
      }
      if (this.config.get_SecuritySystemTargetState == offset)
      {
        this.log.debug( "[" + this.name + "] Push SecuritySystemTargetState:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // StatelessProgrammableSwitch, Doorbell
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_StatelessProgrammableSwitch' || this.config.accessory == 'PLC_Doorbell'){
      if (this.config.get_ProgrammableSwitchEvent == offset)
      {
        this.log.debug( "[" + this.name + "] Push ProgrammableSwitchEvent:" + value);
        this.service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // LockMechanism, LockMechanismBool
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LockMechanism' || this.config.accessory == 'PLC_LockMechanismBool'){
      if (this.config.get_LockCurrentState == offset)
      {
        this.log.debug( "[" + this.name + "] Push LockCurrentState:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.LockCurrentState).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_LockTargetState == offset)
      {
        this.log.debug( "[" + this.name + "] Push LockTargetState:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.LockTargetState).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // GarageDoorOpener
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_GarageDoorOpener'){
      if (this.config.get_CurrentDoorState == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentDoorState:" + value);
        this.service.getCharacteristic(Characteristic.CurrentDoorState).updateValue(value);
        rv = true;
      }
      if (this.config.get_TargetDoorState == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetDoorState:" + value);
        this.service.getCharacteristic(Characteristic.TargetDoorState).updateValue(value);
        rv = true;
      }
      if (this.config.get_ObstructionDetected == offset)
      {
        this.log.debug( "[" + this.name + "] Push ObstructionDetected:" + value);
        this.service.getCharacteristic(Characteristic.TargetDoorState).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // SmokeSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_SmokeSensor'){
      if (this.config.get_SmokeDetected == offset)
      {
        this.log.debug( "[" + this.name + "] Push SmokeDetected:" + value);
        this.service.getCharacteristic(Characteristic.SmokeDetected).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // Fan
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Fan'){
      if (this.config.get_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Push Active:" + value);
        this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        rv = true;
      }
      if (this.config.get_TargetFanState == offset)
      {
        this.log.debug( "[" + this.name + "] Push TargetFanState:" + String(this.modTargetGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.TargetFanState).updateValue(this.modTargetGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_CurrentFanState == offset)
      {
        this.log.debug( "[" + this.name + "] Push CurrentFanState:" + String(this.modCurrentGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.CurrentFanState).updateValue(this.modCurrentGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_RotationSpeed == offset || this.config.get_RotationSpeedByte)
      {
        this.log.debug( "[" + this.name + "] Push RotationSpeed:" + value);
        this.service.getCharacteristic(Characteristic.Active).RotationSpeed(value);
        rv = true;
      }
      if (this.config.get_RotationDirection == offset)
      {
        this.log.debug( "[" + this.name + "] Push RotationDirection:" + String(this.mapDirectionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.LockTargetState).updateValue(this.mapDirectionGet(parseInt(value)));
        rv = true;
      }
    }
    // PUSH handling ///////////////////////////////////////////////
    // LightSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LightSensor'){

      if ( this.config.get_CurrentAmbientLightLevelDInt == offset )
      {
        this.log.debug( "[" + this.name + "] Push CurrentAmbientLightLevel:" + String(this.modFunctionGet(parseInt(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel).updateValue(this.modFunctionGet(parseInt(value)));
        rv = true;
      }
      if (this.config.get_CurrentAmbientLightLevel == offset )
      {
        this.log.debug( "[" + this.name + "] Push CurrentAmbientLightLevel:" + String(this.modFunctionGet(parseFloat(value))) + "<-" + String(value));
        this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel).updateValue(this.modFunctionGet(parseFloat(value)));
        rv = true;
      }
      if (this.config.get_StatusTampered == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusTampered:" + value);
        this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        rv = true;
      }
      if (this.config.get_StatusLowBattery == offset)
      {
        this.log.debug( "[" + this.name + "] Push StatusLowBattery:" + value);
        this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        rv = true;
      }
    }

    return rv;
  },

  ////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////
  // CONTROL handling
  ////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////
  updateControl: function(offset, value)
  {
    var rv = false;
    //this.log.debug("["+ this.name +"] ("+ this.config.accessory +") Received updateControl offset:" + offset + " value:" + value);
    // CONTROL handling ////////////////////////////////////////////
    // Lightbulb, Outlet, Switch
    ////////////////////////////////////////////////////////////////
    if (this.config.accessory == 'PLC_LightBulb' ||
        this.config.accessory == 'PLC_Outlet' ||
        this.config.accessory == 'PLC_Switch') {
      if (this.config.set_On == offset)
      {
        this.log.debug( "[" + this.name + "] Control On:" + value);
        this.service.getCharacteristic(Characteristic.On).setValue(value);
        rv = true;
      }
      if (this.config.accessory == 'PLC_LightBulb' && this.config.set_Brightness == offset)
      {
        this.log.debug( "[" + this.name + "] Control Brightness:" + value);
        this.service.getCharacteristic(Characteristic.Brightness).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // TemperatureSensor
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // HumiditySensor
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // Thermostat
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Thermostat'){
      if (this.config.set_TargetTemperature == offset)
      {
        this.log.debug( "[" + this.name + "] Control TargetTemperature:" + value);
        this.service.getCharacteristic(Characteristic.TargetTemperature).setValue(value);
        rv = true;
      }
      if (this.config.set_TargetRelativeHumidity == offset)
      {
        this.log.debug( "[" + this.name + "] Control TargetRelativeHumidity:" + value);
        this.service.getCharacteristic(Characteristic.TargetRelativeHumidity).setValue(value);
        rv = true;
      }
      if (this.config.set_TargetHeatingCoolingState == offset)
      {
        this.log.debug( "[" + this.name + "] Control TargetHeatingCoolingState:" + value);
        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // Humidifier Dehumidifier
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_HumidifierDehumidifier'){
      if (this.config.set_TargetHumidifierDehumidifierState == offset)
      {
        this.log.debug( "[" + this.name + "] Control TargetHumidifierDehumidifierState:" + value);
        this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).setValue(value);
        rv = true;
      }
      if (this.config.set_RelativeHumidityDehumidifierThreshold == offset)
      {
        this.log.debug( "[" + this.name + "] Control RelativeHumidityDehumidifierThreshold:" + value);
        this.service.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold).setValue(value);
        rv = true;
      }
      if (this.config.set_RelativeHumidityHumidifierThreshold == offset)
      {
        this.log.debug( "[" + this.name + "] Control RelativeHumidityHumidifierThreshold:" + value);
        this.service.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold).setValue(value);
        rv = true;
      }
      if (this.config.set_RotationSpeed == offset || this.config.set_RotationSpeedByte == offset)
      {
        this.log.debug( "[" + this.name + "] Control RotationSpeed:" + value);
        this.service.getCharacteristic(Characteristic.RotationSpeed).setValue(value);
        rv = true;
      }
      if (this.config.set_SwingMode == offset)
      {
        this.log.debug( "[" + this.name + "] Control SwingMode:" + value);
        this.service.getCharacteristic(Characteristic.SwingMode).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // Window, WindowCovering and Door
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Window' || this.config.accessory == 'PLC_WindowCovering' || this.config.accessory == 'PLC_Door'){
      if (this.config.set_TargetPosition == offset)
      {
          this.log.debug( "[" + this.name + "] Control TargetPosition:" + String(value) );
          this.service.getCharacteristic(Characteristic.TargetPosition).setValue(value);
      }
      if ( this.config.set_HoldPosition == offset)
      {
        this.log.debug( "[" + this.name + "] Control HoldPosition:" + String(value));
        this.service.getCharacteristic(Characteristic.HoldPosition).setValue(this.value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // OccupancySensor
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // MotionSensor
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // ContactSensor
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // LeakDetected
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // Faucet
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Faucet'){
      if (this.config.set_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Control Active:" + value);
        this.service.getCharacteristic(Characteristic.Active).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // Valve
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Valve'){
      if (this.config.set_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Control Active:" + value);
        this.service.getCharacteristic(Characteristic.Active).setValue(value);
        rv = true;
      }
      if (this.config.set_SetDuration == offset)
      {
        this.log.debug( "[" + this.name + "] Control SetDuration:" + value);
        this.service.getCharacteristic(Characteristic.SetDuration).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // SecuritySystem
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_SecuritySystem'){
      if (this.config.set_SecuritySystemTargetState == offset)
      {
        this.log.debug( "[" + this.name + "] Control SecuritySystemTargetState:" + value);
        this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // StatelessProgrammableSwitch, Doorbell
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_StatelessProgrammableSwitch' || this.config.accessory == 'PLC_Doorbell'){
      if (this.config.get_ProgrammableSwitchEvent == offset)
      {
        // Note: In contrast to all others accessories the control does not set the value in the PLC instead it simulates a key event.
        //       Therefore updateValue is
        this.log.debug( "[" + this.name + "] Control ProgrammableSwitchEvent:" + value);
        this.service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).updateValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // LockMechanism
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LockMechanism'){
      if (this.config.set_LockTargetState == offset || this.config.set_Secured == offset)
      {
        this.log.debug( "[" + this.name + "] Control LockTargetState:" + value);
        this.service.getCharacteristic(Characteristic.LockTargetState).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // LockMechanismBool
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LockMechanismBool'){
      if (this.config.set_LockTargetState == offset || this.config.set_Secured == offset)
      {
        var valuePLC = this.invert_bit(parseInt(value));
        this.log.debug( "[" + this.name + "] Control LockTargetState:" + String(value) + "->" + String(valuePLC));
        this.service.getCharacteristic(Characteristic.LockTargetState).setValue(valuePLC);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // GarageDoorOpener
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_GarageDoorOpener'){
      if (this.config.set_TargetDoorState == offset)
      {
        this.log.debug( "[" + this.name + "] Control TargetDoorState:" + value);
        this.service.getCharacteristic(Characteristic.TargetDoorState).setValue(value);
        rv = true;
      }
    }
    // CONTROL handling ////////////////////////////////////////////
    // SmokeSensor
    ////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////
    // CONTROL handling ////////////////////////////////////////////
    // Fan
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Fan'){
      if (this.config.set_Active == offset)
      {
        this.log.debug( "[" + this.name + "] Control Active:" + value);
        this.service.getCharacteristic(Characteristic.Active).setValue(value);
        rv = true;
      }
      if (this.config.set_TargetFanState == offset)
      {
        this.log.debug( "[" + this.name + "] Control TargetFanState:" + value);
        this.service.getCharacteristic(Characteristic.TargetFanState).setValue(value);
        rv = true;
      }
      if (this.config.set_RotationSpeed == offset || this.config.set_RotationSpeedByte == offset)
      {
        this.log.debug( "[" + this.name + "] Control RotationSpeed:" + value);
        this.service.getCharacteristic(Characteristic.RotationSpeed).setValue(value);
        rv = true;
      }
      if (this.config.set_RotationDirection == offset)
      {
        this.log.debug( "[" + this.name + "] Control RotationDirection:" + value);
        this.service.getCharacteristic(Characteristic.RotationDirection).setValue(value);
        rv = true;
      }
    }

    return rv;
  },

  ////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////
  // POLL handling
  ////////////////////////////////////////////////////////////////
  ////////////////////////////////////////////////////////////////
  updatePoll: function()
  {
    // POLL handling ///////////////////////////////////////////////
    // Lightbulb, Outlet, Switch
    ////////////////////////////////////////////////////////////////
    if (this.config.accessory == 'PLC_LightBulb' ||
    this.config.accessory == 'PLC_Outlet' ||
    this.config.accessory == 'PLC_Switch') {
      this.service.getCharacteristic(Characteristic.On).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.On).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // TemperatureSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_TemperatureSensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.CurrentTemperature).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // HumiditySensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_HumiditySensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // Thermostat
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Thermostat') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.CurrentTemperature).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.TargetTemperature).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetTemperature).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.TargetRelativeHumidity).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetRelativeHumidity).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // Humidifier Dehumidifier
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_HumidifierDehumidifier') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.Active).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.RotationSpeed).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.RotationSpeed).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.SwingMode).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.SwingMode).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // Window, WindowCovering and Door
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Window' || this.config.accessory == 'PLC_WindowCovering' || this.config.accessory == 'PLC_Door'){
      this.service.getCharacteristic(Characteristic.CurrentPosition).getValue(function(err, value) {
        if (!err) {
          if (this.adaptivePollActive )  {
            if( this.lastTargetPos == value) {
              this.adaptivePollActive = false;
              this.log.debug( "[" + this.name + "] reached target position disable adaptive polling: " + value);
            }
            else
            {
              this.pollCounter = this.adaptivePollingInterval;
              this.log.debug( "[" + this.name + "] continue adaptive polling (" + this.pollCounter + "s): " + this.lastTargetPos +" != " + value);
            }
          }
          this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // OccupancySensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_OccupancySensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.OccupancyDetected).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // MotionSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_MotionSensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.MotionDetected).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.MotionDetected).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // ContactSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_ContactSensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.ContactSensorState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.ContactSensorState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // LeakSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LeakSensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.LeakDetected).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.LeakDetected).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // Faucet
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Faucet') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.Active).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // Valve
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Valve') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.Active).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // SecuritySystem
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_SecuritySystem') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(value);
        }
      }.bind(this));
      // get the current system state and update the value.
      this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // StatelessProgrammableSwitch, Doorbell
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_StatelessProgrammableSwitch' || this.config.accessory == 'PLC_Doorbell'){
      this.getBit(function(err,value){
          if(!err && value)
          {
            this.getByte(function(err, event) {
              if (!err) {
                this.service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).updateValue(event);
                this.log.info( "[" + this.name + "] Stateless switch event :" + event);
                this.setBit(0,function(err){},
                  this.config.db,
                  Math.floor(this.config.isEvent), Math.floor((this.config.isEvent*10)%10),
                  'clear IsEvent');
              }
            }.bind(this),
            this.config.db,
            this.config.get_ProgrammableSwitchEvent,
            'read Event'
            ),
            this.service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).getValue();
          }
         }.bind(this),
        this.config.db,
        Math.floor(this.config.isEvent), Math.floor((this.config.isEvent*10)%10),
        'poll isEvent'
      );
    }
    // POLL handling ///////////////////////////////////////////////
    // LockMechanism, LockMechanismBool
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LockMechanism' || this.config.accessory == 'PLC_LockMechanismBool') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.LockCurrentState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.LockCurrentState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.LockTargetState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.LockTargetState).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // GarageDoorOpener
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_GarageDoorOpener') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.CurrentDoorState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentDoorState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.ObstructionDetected).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.ObstructionDetected).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.TargetDoorState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetDoorState).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // SmokeSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_SmokeSensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.SmokeDetected).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.SmokeDetected).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // Fan
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_Fan') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.Active).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.Active).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.TargetFanState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.TargetFanState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.CurrentFanState).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentFanState).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.RotationSpeed).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.RotationSpeed).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.RotationDirection).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.RotationDirection).updateValue(value);
        }
      }.bind(this));
    }
    // POLL handling ///////////////////////////////////////////////
    // LightSensor
    ////////////////////////////////////////////////////////////////
    else if (this.config.accessory == 'PLC_LightSensor') {
      // get the current target system state and update the value.
      this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusTampered).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(value);
        }
      }.bind(this));
      this.service.getCharacteristic(Characteristic.StatusLowBattery).getValue(function(err, value) {
        if (!err) {
          this.service.getCharacteristic(Characteristic.StatusLowBattery).updateValue(value);
        }
      }.bind(this));
    }
  },

  getServices: function() {
    return [this.accessory.getService(Service.AccessoryInformation), this.service];
  },


  plain: function(value) {
    return value;
  },

  invert_0_100: function(value) {
    return 100-value;
  },

  invert_bit: function(value) {
    return (value ? 0 : 1);
  },

  mapFunction: function(value, map) {
    var rv = 100;

    if (value >= 0 && value < map.length) {
      rv = map[value];
    }
    else {
      this.log.error("[mapFunction] value:" + value + " is out ouf range of mapping array with "+ map.length + " elements");
    }
    return rv;
  },

  limitFunction: function(value, min, max){
    rv = value;
    if( rv < min) {
      rv = min;
    }
    else if(rv >max) {
      rv = max;
    }
    return rv;
  },


  s7time2int: function(value){
    var val = Math.ceil(value/1000);
    if (val > 3600) {
      val = 3600;
    }
    if (val < 0) {
      val = 0;
    }
    return val;
  },

  int27time: function(value){
    return (value * 1000);
  },

  //////////////////////////////////////////////////////////////////////////////
  // DUMMY
  //////////////////////////////////////////////////////////////////////////////
  setDummy: function(value, callback, characteristic, inform) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setDummy)";
    this.log.debug(logprefix , String(value));
    callback(null);
    if (typeof(inform) != 'undefined' && inform)
    {
      inform(value);
    }
  },

  handleDummy: function(callback, characteristic) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (handleDummy)";
    this.log.debug(logprefix + "executed");
    callback(null);
  },

  getDummy: function(callback, value, characteristic) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (getDummy)";
    this.log.debug(logprefix , String(value));
    callback(null, value);
  },


  //////////////////////////////////////////////////////////////////////////////
  // BIT
  //////////////////////////////////////////////////////////////////////////////
  setOnOffBit: function(value, callback, db, on_offset, on_bit, off_offset, off_bit, characteristic, inform) {
    //Set single bit depending on value
    const offset = value ? on_offset : off_offset;
    const bit = value ? on_bit : off_bit;
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setOnOffBit DB" + db + "DBX"+ offset + "." + bit + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var buf = Buffer.alloc(1);

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
      buf.writeUInt8(1);
      if (!S7Client.WriteArea(S7Client.S7AreaDB, db, ((offset*8) + bit), 1, S7Client.S7WLBit, buf)) {
        var err = S7Client.LastError();
        log.error(logprefix, "WriteArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
        if(err & 0xFFFFF) {S7Client.Disconnect();}
        callback(new Error('PLC error'));
      }
      else {
        log.debug(logprefix + " %d ms", String(value), S7Client.ExecTime());
        callback(null);
        if (typeof(inform) != 'undefined' && inform)
        {
          inform(value);
        }        
      }
    }
    else {
      callback(new Error('PLC not connected'), false);
    }
    //this.platform.mirrorSet(logprefix, "&db="+db+"&offset="+ on_offset + "." + on_bit + "&value="+ value);
  },

  setBit: function(value, callback, db, offset, bit, characteristic, inform, valueMod) {
    //Set single bit depending on value
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setBit DB" + db + "DBX"+ offset + "." + bit + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var buf = Buffer.alloc(1);
    var valuePLC = value;
    if (typeof(valueMod) != 'undefined' && valueMod)
    {
      valuePLC = valueMod(value);
    }

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
      buf.writeInt8(valuePLC ? 1 : 0);
      if (!S7Client.WriteArea(S7Client.S7AreaDB, db, ((offset*8) + bit), 1, S7Client.S7WLBit, buf)) {
        var err = S7Client.LastError();
        log.error(logprefix, "WriteArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
        if(err & 0xFFFFF) {S7Client.Disconnect();}
        callback(new Error('PLC error'));
      }
      else {
        if (typeof(valueMod) != 'undefined' && valueMod)
        {
          log.debug(logprefix + " %d ms", String(value) + "->" + String(valuePLC), S7Client.ExecTime());
        }
        else
        {
          log.debug(logprefix + " %d ms", String(value), S7Client.ExecTime());
        }
        callback(null);
        if (typeof(inform) != 'undefined' && inform)
        {
          inform(value);
        }
      }
    }
    else {
      callback(new Error('PLC not connected'), false);
    }
    //this.platform.mirrorSet(logprefix, "&db="+db+"&offset="+ offset + "." + bit + "&value="+ valuePLC);
  },


  getBit: function(callback, db, offset, bit, characteristic, valueMod) {
    //read single bit
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (getBit DB" + db + "DBX"+ offset + "." + bit + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var pushMirror = function(value) { this.platform.mirrorGet(logprefix, "&db="+db+"&offset="+ offset + "." + bit + "&value="+ value);}.bind(this);

    //check PLC connection
    if (this.platform.S7ClientConnect()) {
      S7Client.ReadArea(S7Client.S7AreaDB, db, ((offset*8) + bit), 1, S7Client.S7WLBit, function(err, res) {
        if(err) {
          log.error(logprefix, "ReadArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
          if(err & 0xFFFFF) {S7Client.Disconnect();}
          callback(err, 0);
        }
        else {
          const valuePLC = ((res[0]) ? 1 : 0);
          var value = valuePLC;
          if (typeof(valueMod) != 'undefined' && valueMod)
          {
            value = valueMod(valuePLC);
            log.debug(logprefix , String(value) + "<-" + String(valuePLC));
          }
          else
          {
            log.debug(logprefix , String(value));
          }
          callback(null, value);
          pushMirror(valuePLC);
        }
      });
    }
    else {
      callback(new Error('PLC not connected'), false);
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // REAL
  //////////////////////////////////////////////////////////////////////////////
  setReal: function(value, callback, db, offset, characteristic, inform, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setReal DB" + db + "DBD"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var buf = Buffer.alloc(4);
    var valuePLC = value;
    if (typeof(valueMod) != 'undefined' && valueMod)
    {
      valuePLC = valueMod(value);
    }

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
      buf.writeFloatBE(valuePLC);
      if (!S7Client.WriteArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLReal, buf)) {
        var err = S7Client.LastError();
        log.error(logprefix, "WriteArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
        if(err & 0xFFFFF) {S7Client.Disconnect();}
        callback(new Error('PLC error'));
      }
      else {
        if (typeof(valueMod) != 'undefined' && valueMod)
        {
          log.debug(logprefix + " %d ms", String(value) + "->" + String(valuePLC), S7Client.ExecTime());
        }
        else
        {
          log.debug(logprefix + " %d ms", String(value), S7Client.ExecTime());
        }
        callback(null);
        if (typeof(inform) != 'undefined' && inform)
        {
          inform(value);
        }
      }
    }
    else {
        callback(new Error('PLC not connected'));
    }
    //this.platform.mirrorSet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ valuePLC);
  },

  getReal: function(callback, db, offset, characteristic, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (getReal DB" + db + "DBD"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var value = 0;
    var pushMirror = function(value) { this.platform.mirrorGet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ value);}.bind(this);

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
        S7Client.ReadArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLReal, function(err, res) {
          if(err) {
            log.error(logprefix, "ReadArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
            if(err & 0xFFFFF) {S7Client.Disconnect();}
            callback(new Error('PLC error'));
          }
          else {
            var valuePLC = res.readFloatBE();
            if (typeof(valueMod) != 'undefined' && valueMod)
            {
              value = valueMod(valuePLC);
              log.debug(logprefix , String(value) + "<-" + String(valuePLC));
            }
            else
            {
              value = valuePLC;
              log.debug(logprefix , String(value));
            }
            callback(null, value);
            pushMirror(valuePLC);
          }
        });
    }
    else {
        callback(new Error('PLC not connected'));
    }
  },


  //////////////////////////////////////////////////////////////////////////////
  // BYTE
  //////////////////////////////////////////////////////////////////////////////
  setByte: function(value, callback, db, offset, characteristic, inform, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setByte DB" + db + "DBB"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var buf = Buffer.alloc(1);
    var valuePLC = value;
    if (typeof(valueMod) != 'undefined' && valueMod)
    {
      valuePLC = valueMod(value);
    }

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
      buf.writeUInt8(valuePLC);
      if (!S7Client.WriteArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLByte, buf)) {
        var err = S7Client.LastError();
        log.error(logprefix, "WriteArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
        if(err & 0xFFFFF) {S7Client.Disconnect();}
        callback(new Error('PLC error'));
      }
      else {
        if (typeof(valueMod) != 'undefined' && valueMod)
        {
          log.debug(logprefix , String(value) + "->" + String(valuePLC));
        }
        else
        {
          log.debug(logprefix , String(value));
        }
        callback(null);
        if (typeof(inform) != 'undefined' && inform)
        {
          inform(value);
        }
      }
    }
    else {
        callback(new Error('PLC not connected'));
    }
    //this.platform.mirrorSet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ valuePLC);
  },

  getByte: function(callback, db, offset, characteristic, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (getByte DB" + db + "DBB"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var value = 0;
    var pushMirror = function(value) { this.platform.mirrorGet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ value);}.bind(this);

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
        S7Client.ReadArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLByte, function(err, res) {
          if(err) {
            log.error(logprefix, "ReadArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
            if(err & 0xFFFFF) {S7Client.Disconnect();}
            callback(new Error('PLC error'));
          }
          else {
            var valuePLC = res.readUInt8();
            if (typeof(valueMod) != 'undefined' && valueMod)
            {
              value = valueMod(valuePLC);
              log.debug(logprefix , String(value) + "<-" + String(valuePLC));
            }
            else
            {
              value = valuePLC;
              log.debug(logprefix , String(value));
            }
            callback(null, value);
            pushMirror(valuePLC);
          }
        });
    }
    else {
        callback(new Error('PLC not connected'));
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // INT
  //////////////////////////////////////////////////////////////////////////////
  setInt: function(value, callback, db, offset, characteristic, inform, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setInt DB" + db + "DBW"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var buf = Buffer.alloc(2);
    var valuePLC = value;
    if (typeof(valueMod) != 'undefined' && valueMod)
    {
      valuePLC = valueMod(value);
    }

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
      buf.writeInt16BE(valuePLC);
      if (!S7Client.WriteArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLWord, buf)) {
        var err = S7Client.LastError();
        log.error(logprefix, "WriteArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
        if(err & 0xFFFFF) {S7Client.Disconnect();}
        callback(new Error('PLC error'));
      }
      else {
        if (typeof(valueMod) != 'undefined' && valueMod)
        {
          log.debug(logprefix + " %d ms", String(value) + "->" + String(valuePLC)), S7Client.ExecTime();
        }
        else
        {
          log.debug(logprefix + " %d ms", String(value), S7Client.ExecTime());
        }
        callback(null);
        if (typeof(inform) != 'undefined' && inform)
        {
          inform(value);
        }
      }
    }
    else {
        callback(new Error('PLC not connected'));
    }
    //this.platform.mirrorSet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ valuePLC);
  },

  getInt: function(callback, db, offset, characteristic, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (getInt DB" + db + "DBW"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var value = 0;
    var valuePLC = 0;
    var pushMirror = function(value) { this.platform.mirrorGet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ value);}.bind(this);

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
        S7Client.ReadArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLWord, function(err, res) {
          if(err) {
            log.error(logprefix, "ReadArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
            if(err & 0xFFFFF) {S7Client.Disconnect();}
            callback(new Error('PLC error'));
          }
          else {
            valuePLC = res.readInt16BE();
            if (typeof(valueMod) != 'undefined' && valueMod)
            {
              value = valueMod(valuePLC);
              log.debug(logprefix , String(value) + "<-" + String(valuePLC));
            }
            else
            {
              value = valuePLC;
              log.debug(logprefix , String(value));
            }
            callback(null, value);
            pushMirror(valuePLC);
          }
        });
    }
    else {
        callback(new Error('PLC not connected'));
    }
  },



  //////////////////////////////////////////////////////////////////////////////
  // DInt
  //////////////////////////////////////////////////////////////////////////////
  setDInt: function(value, callback, db, offset, characteristic, inform, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (setDInt DB" + db + "DBD"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var buf = Buffer.alloc(4);
    var valuePLC = value;
    if (typeof(valueMod) != 'undefined' && valueMod)
    {
      valuePLC = valueMod(value);
    }

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
      buf.writeInt32BE(valuePLC);
      if (!S7Client.WriteArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLDWord, buf)) {
        var err = S7Client.LastError();
        log.error(logprefix, "WriteArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
        if(err & 0xFFFFF) {S7Client.Disconnect();}
        callback(new Error('PLC error'));
      }
      else {
        if (typeof(valueMod) != 'undefined' && valueMod)
        {
          log.debug(logprefix + " %d ms", String(value) + "->" + String(valuePLC), S7Client.ExecTime());
        }
        else
        {
          log.debug(logprefix + " %d ms", String(value), S7Client.ExecTime());
        }
        callback(null);
        if (typeof(inform) != 'undefined' && inform)
        {
          inform(value);
        }
      }
    }
    else {
        callback(new Error('PLC not connected'));
    }
    //this.platform.mirrorSet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ valuePLC);
  },

  getDInt: function(callback, db, offset, characteristic, valueMod) {
    var logprefix = "[" + this.name + "] " + characteristic + ": %s (getDInt DB" + db + "DBD"+ offset + ")";
    var S7Client = this.platform.S7Client;
    var log = this.log;
    var value = 0;
    var valuePLC = 0;
    var pushMirror = function(value) { this.platform.mirrorGet(logprefix, "&db="+db+"&offset="+ offset + "&value="+ value);}.bind(this);

    //ensure PLC connection
    if (this.platform.S7ClientConnect()) {
        S7Client.ReadArea(S7Client.S7AreaDB, db, offset, 1, S7Client.S7WLDWord, function(err, res) {
          if(err) {
            log.error(logprefix, "ReadArea failed #" + err.toString(16) + " - " + S7Client.ErrorText(err));
            if(err & 0xFFFFF) {S7Client.Disconnect();}
            callback(new Error('PLC error'));
          }
          else {
            valuePLC = res.readInt32BE();
            if (typeof(valueMod) != 'undefined' && valueMod)
            {
              value = valueMod(valuePLC);
              log.debug(logprefix , String(value) + "<-" + String(valuePLC));
            }
            else
            {
              value = valuePLC;
              log.debug(logprefix , String(value));
            }
            callback(null, value);
            pushMirror(valuePLC);
          }
        });
    }
    else {
        callback(new Error('PLC not connected'));
    }
  }
};

