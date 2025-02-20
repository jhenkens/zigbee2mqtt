const logger = require('../util/logger');
const settings = require('../util/settings');
const utils = require('../util/utils');
const zigbeeHerdsmanConverters = require('zigbee-herdsman-converters');
const Extension = require('./extension');

// Pingable end devices, some end devices should be pinged
// e.g. E11-G13 https://github.com/Koenkk/zigbee2mqtt/issues/775#issuecomment-453683846
const pingableEndDevices = [
    zigbeeHerdsmanConverters.devices.find((d) => d.model === 'E11-G13'),
    zigbeeHerdsmanConverters.devices.find((d) => d.model === '53170161'),
];

const Hours25 = 1000 * 60 * 60 * 25;

/**
 * This extensions pings devices to check if they are online.
 */
class Availability extends Extension {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus) {
        super(zigbee, mqtt, state, publishEntityState, eventBus);

        this.refresh_state_on_startup = settings.get().advanced.availability_refresh_state_on_startup;
        this.availability_timeout = settings.get().advanced.availability_timeout;
        this.availability_reconnect_converter_keys = settings.get().advanced.availability_reconnect_converter_keys;
        this.timers = {};
        this.state = {};

        this.blocklist = settings.get().advanced.availability_blocklist
            .concat(settings.get().advanced.availability_blacklist)
            .map((e) => settings.getEntity(e).ID);

        this.passlist = settings.get().advanced.availability_passlist
            .concat(settings.get().advanced.availability_whitelist)
            .map((e) => settings.getEntity(e).ID);
    }

    inPasslistOrNotInBlocklist(device) {
        const ieeeAddr = device.ieeeAddr;
        const deviceSettings = settings.getDevice(ieeeAddr);
        const name = deviceSettings.friendlyName;

        // Passlist is not empty and device is in it, enable availability
        if (this.passlist.length > 0) {
            return this.passlist.includes(ieeeAddr) || (name && this.passlist.includes(name));
        }

        // Device is on blocklist, disable availability
        if (this.blocklist.includes(ieeeAddr) || (name && this.blocklist.includes(name))) {
            return false;
        }

        return true;
    }

    isPingable(device) {
        if (pingableEndDevices.find((d) => d.hasOwnProperty('zigbeeModel') && d.zigbeeModel.includes(device.modelID))) {
            return true;
        }

        // Device is a mains powered router
        return device.type === 'Router' && device.powerSource !== 'Battery';
    }

    async onMQTTConnected() {
        for (const device of this.zigbee.getClients()) {
            this.connectDevice(device);
        }
    }

    isPingOnStartupEnabledForDevice(device) {
        // Allows for "non-pingable" devices  (e.g., battery powered locks) to be pinged at startup
        return this.getSettingForDevice(
            this.isPingable(device),
            'availability_ping_device_on_startup',
            device );
    }

    isRefreshOnStartupEnabledForDevice(device) {
        return this.getSettingForDevice(
            this.refresh_state_on_startup && this.isPingable(device),
            'availability_refresh_state_on_startup',
            device );
    }

    getSettingForDevice(initialValue, setting, device) {
        // Update pingable devices on startup, if enabled.
        let value = initialValue;
        const deviceSettings = settings.getDevice(device.ieeeAddr);
        // Listen to device overrides
        if (deviceSettings &&
            deviceSettings.hasOwnProperty(setting)) {
            value = deviceSettings[setting];
        }
        return value;
    }

    async connectDevice(device) {
        // Mark all devices as online on start
        const ieeeAddr = device.ieeeAddr;

        if (this.isPingOnStartupEnabledForDevice(device)) {
            await this.handleIntervalPingable(device, false);
        }

        this.publishAvailability(
            device,
            this.state.hasOwnProperty(ieeeAddr) ? this.state[ieeeAddr] : true, true);

        if (this.inPasslistOrNotInBlocklist(device)) {
            if (this.isPingable(device)) {
                this.setTimerPingable(device);
            } else {
                this.timers[ieeeAddr] = setInterval(() => {
                    this.handleIntervalNotPingable(device);
                }, utils.secondsToMilliseconds(300));
            }
        }
    }

    async handleIntervalPingable(device, queue=true) {
        const resolvedEntity = this.zigbee.resolveEntity(device.ieeeAddr);
        if (!resolvedEntity) {
            logger.debug(`Stop pinging '${device.ieeeAddr}', device is not known anymore`);
            return;
        }

        // When a device is already unavailable, log the ping failed on 'debug' instead of 'error'.
        const level = this.state.hasOwnProperty(device.ieeeAddr) && !this.state[device.ieeeAddr] ? 'debug' : 'error';
        try {
            await device.ping();
            this.publishAvailability(device, true);
            logger.debug(`Successfully pinged '${resolvedEntity.name}'`);
        } catch (error) {
            this.publishAvailability(device, false);
            logger[level](`Failed to ping '${resolvedEntity.name}'`);
        } finally {
            if (queue) {
                this.setTimerPingable(device);
            }
        }
    }

    async handleIntervalNotPingable(device) {
        const resolvedEntity = this.zigbee.resolveEntity(device.ieeeAddr);
        if (!resolvedEntity || !device.lastSeen) {
            return;
        }

        const ago = Date.now() - resolvedEntity.device.lastSeen;
        logger.debug(`Non-pingable device '${resolvedEntity.name}' was last seen '${ago / 1000}' seconds ago.`);

        if (ago > Hours25) {
            this.publishAvailability(device, false);
        }
    }

    setTimerPingable(device) {
        if (this.timers[device.ieeeAddr]) {
            clearTimeout(this.timers[device.ieeeAddr]);
        }

        this.timers[device.ieeeAddr] = setTimeout(async () => {
            await this.handleIntervalPingable(device);
        }, utils.secondsToMilliseconds(this.availability_timeout));
    }

    async stop() {
        super.stop();
        for (const timer of Object.values(this.timers)) {
            clearTimeout(timer);
        }

        this.zigbee.getClients().forEach((device) => this.publishAvailability(device, false));
    }

    async refreshState(device) {
        const resolvedEntity = this.zigbee.resolveEntity(device);
        if (resolvedEntity && resolvedEntity.definition) {
            // device_setting availability_on_reconnect allows for disabling state lookup on reconnect. Useful to save
            // battery, while still allowing availability
            if (resolvedEntity.settings.hasOwnProperty('availability_allow_refresh_state') &&
                !resolvedEntity.settings.availability_allow_refresh_state) return;

            const used = [];
            try {
                const meta = {
                    options: {...settings.get().device_options, ...resolvedEntity.settings},
                    logger,
                    device: resolvedEntity.device,
                    mapped: resolvedEntity.definition,
                };
                for (const key of this.availability_reconnect_converter_keys) {
                    const converter = resolvedEntity.definition.toZigbee.find((tz) => tz.key.includes(key));
                    if (converter && !used.includes(converter)) {
                        await converter.convertGet(device.endpoints[0], key, meta);
                        used.push(converter);
                    }
                }
            } catch (error) {
                logger.error(`Failed to read state of '${resolvedEntity.name}' after reconnect`, error);
            }
        }
    }

    publishAvailability(device, available, force=false) {
        const ieeeAddr = device.ieeeAddr;

        const shouldPublishAvailability = this.state[ieeeAddr] !== available || force;

        const shouldRefreshDueToStartup = available && !this.state.hasOwnProperty(ieeeAddr) &&
            this.isRefreshOnStartupEnabledForDevice(device);
        const shouldRefreshDueToReconnect = available &&
            this.state.hasOwnProperty(ieeeAddr) && !this.state[ieeeAddr];

        // Update before refreshing, so that we don't trigger multiple times
        this.state[ieeeAddr] = available;

        if (shouldRefreshDueToStartup || shouldRefreshDueToReconnect) {
            this.refreshState(device);
        }

        if (shouldPublishAvailability) {
            const deviceSettings = settings.getDevice(ieeeAddr);
            const name = deviceSettings ? deviceSettings.friendlyName : ieeeAddr;
            const topic = `${name}/availability`;
            const payload = available ? 'online' : 'offline';
            this.state[ieeeAddr] = available;
            this.mqtt.publish(topic, payload, {retain: true, qos: 0});
        }
    }

    onZigbeeEvent(type, data, resolvedEntity) {
        const device = data.device;
        if (!device) {
            return;
        }

        if (this.inPasslistOrNotInBlocklist(device)) {
            this.publishAvailability(data.device, true);

            if (this.isPingable(device)) {
                // When a zigbee message from a device is received we know the device is still alive.
                // => reset the timer.
                this.setTimerPingable(device);

                const online = this.state.hasOwnProperty(device.ieeeAddr) && this.state[device.ieeeAddr];
                if (online && type === 'deviceAnnounce' && !utils.isIkeaTradfriDevice(device)) {
                    /**
                     * In case the device is powered off AND on within the availability timeout,
                     * zigbee2qmtt does not detect the device as offline (device is still marked online).
                     * When a device is turned on again the state could be out of sync.
                     * https://github.com/Koenkk/zigbee2mqtt/issues/1383#issuecomment-489412168
                     * deviceAnnounce is typically send when a device comes online.
                     *
                     * This isn't needed for TRADFRI devices as they already send the state themself.
                     */
                    this.refreshState(device);
                }
            }
        }
    }
}

module.exports = Availability;
