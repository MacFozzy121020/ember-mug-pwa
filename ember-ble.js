/**
 * Ember Mug BLE GATT Client
 * Handles Web Bluetooth discovery, connection, Pixel keep-alive/auto-reconnect,
 * push event notifications, and characteristic reads/writes.
 */

export const EMBER_SERVICE_UUID = 'fc543622-236c-4c94-8fa9-944a3e5353fa';

export const EMBER_CHARS = {
  DRINK_NAME:   'fc540001-236c-4c94-8fa9-944a3e5353fa',
  CURRENT_TEMP: 'fc540002-236c-4c94-8fa9-944a3e5353fa',
  TARGET_TEMP:  'fc540003-236c-4c94-8fa9-944a3e5353fa',
  TEMP_UNIT:    'fc540004-236c-4c94-8fa9-944a3e5353fa',
  LIQUID_LEVEL: 'fc540005-236c-4c94-8fa9-944a3e5353fa',
  BATTERY:      'fc540007-236c-4c94-8fa9-944a3e5353fa',
  LIQUID_STATE: 'fc540008-236c-4c94-8fa9-944a3e5353fa',
  PUSH_EVENT:   'fc540012-236c-4c94-8fa9-944a3e5353fa',
  LED_COLOR:    'fc540014-236c-4c94-8fa9-944a3e5353fa',
};

export const LIQUID_STATES = {
  0: { label: 'Unknown', icon: 'help', stateClass: 'idle' },
  1: { label: 'Empty', icon: 'empty', stateClass: 'empty' },
  2: { label: 'Filling', icon: 'filling', stateClass: 'filling' },
  3: { label: 'Cold', icon: 'cooling', stateClass: 'cooling' },
  4: { label: 'Cooling to target', icon: 'cooling', stateClass: 'cooling' },
  5: { label: 'Heating to target', icon: 'heating', stateClass: 'heating' },
  6: { label: 'Perfect temperature', icon: 'perfect', stateClass: 'perfect' },
};

export const PUSH_EVENTS = {
  1: 'REFRESH_BATTERY',
  2: 'CHARGING',
  3: 'NOT_CHARGING',
  4: 'REFRESH_TARGET_TEMP',
  5: 'REFRESH_CURRENT_TEMP',
  6: 'REFRESH_AUTH',
  7: 'REFRESH_LIQUID_LEVEL',
  8: 'REFRESH_LIQUID_STATE',
};

export class EmberBluetoothClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.service = null;
    this.characteristics = new Map();

    this.autoReconnect = true;
    this.isConnecting = false;
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 12;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.operationQueue = Promise.resolve();

    this.state = {
      connected: false,
      reconnecting: false,
      deviceName: 'Ember Mug',
      currentTempC: null,
      targetTempC: null,
      unit: 'C', // 'C' or 'F'
      batteryPercent: null,
      isCharging: false,
      liquidState: 0,
      liquidLevel: null,
      ledColor: null, // { r, g, b, a }
      lastUpdated: null,
    };

    this._onDisconnected = this._onDisconnected.bind(this);
    this._onPushEvent = this._onPushEvent.bind(this);
  }

  log(message, level = 'info') {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      message,
      level,
    };
    this.dispatchEvent(new CustomEvent('log', { detail: entry }));
  }

  emitState() {
    this.state.lastUpdated = new Date();
    this.dispatchEvent(new CustomEvent('statechange', { detail: { ...this.state } }));
  }

  /**
   * Queue GATT operations sequentially (Android/Pixel BLE allows only 1 in-flight GATT op at a time)
   */
  enqueueGatt(fn) {
    const next = this.operationQueue.then(() => fn());
    this.operationQueue = next.catch(() => {});
    return next;
  }

  /**
   * Request device via Web Bluetooth picker
   */
  async requestAndConnect() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser. Use Chrome on Android or Desktop.');
    }

    this.manualDisconnect = false;
    this._clearTimers();

    this.log('Opening Bluetooth device chooser...');
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [EMBER_SERVICE_UUID] },
          { namePrefix: 'Ember' },
        ],
        optionalServices: [EMBER_SERVICE_UUID, 'battery_service', 'device_information'],
      });

      this.AttachDevice(device);
      await this.connectGatt();
    } catch (err) {
      this.log(`Device selection cancelled or failed: ${err.message}`, 'warn');
      throw err;
    }
  }

  /**
   * Try to reconnect to previously permitted devices if browser supports getDevices()
   */
  async tryRestorePairedDevice() {
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') {
      return false;
    }
    try {
      const devices = await navigator.bluetooth.getDevices();
      const ember = devices.find((d) => d.name && d.name.startsWith('Ember')) || devices[0];
      if (ember) {
        this.log(`Found previously paired mug: ${ember.name || ember.id}`);
        this.AttachDevice(ember);
        await this.connectGatt();
        return true;
      }
    } catch (err) {
      this.log(`Could not auto-restore device: ${err.message}`, 'warn');
    }
    return false;
  }

  AttachDevice(device) {
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    }
    this.device = device;
    this.state.deviceName = device.name || 'Ember Mug';
    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
  }

  async connectGatt() {
    if (!this.device || this.isConnecting) return;
    this.isConnecting = true;
    this.characteristics.clear();

    try {
      this.log(`Connecting to ${this.state.deviceName} GATT server...`);
      // Pixel BLE workaround: small delay before GATT connect helps avoid status 133 on Android
      await new Promise((r) => setTimeout(r, 250));

      this.server = await this.device.gatt.connect();
      this.log('GATT server connected. Discovering Ember service...');

      this.service = await this.server.getPrimaryService(EMBER_SERVICE_UUID);
      const chars = await this.service.getCharacteristics();

      for (const c of chars) {
        this.characteristics.set(c.uuid.toLowerCase(), c);
      }
      this.log(`Discovered ${this.characteristics.size} Ember characteristics.`);

      this.state.connected = true;
      this.state.reconnecting = false;
      this.reconnectAttempts = 0;
      this.emitState();

      // Subscribe to push notifications if available
      await this._subscribePushEvents();

      // Initial full state read
      await this.refreshAll();

      // Start Pixel keep-alive & polling loop (every 6 seconds)
      this._startPolling();
      this.log('Mug ready and active keep-alive started.', 'success');
    } catch (err) {
      this.log(`Connection error: ${err.message}`, 'error');
      this.state.connected = false;
      this.emitState();
      if (!this.manualDisconnect && this.autoReconnect) {
        this._scheduleReconnect();
      } else {
        throw err;
      }
    } finally {
      this.isConnecting = false;
    }
  }

  async _subscribePushEvents() {
    const pushChar = this.characteristics.get(EMBER_CHARS.PUSH_EVENT);
    if (!pushChar) {
      this.log('Push event characteristic (fc540012) not exposed; relying on polling.', 'info');
      return;
    }

    try {
      await this.enqueueGatt(async () => {
        await pushChar.startNotifications();
        pushChar.addEventListener('characteristicvaluechanged', this._onPushEvent);
      });
      this.log('Subscribed to real-time mug push notifications (fc540012).');
    } catch (err) {
      // On Android / Pixel, startNotifications on fc540012 can fail if mug isn't bonded at OS level
      this.log(
        `Note: Push notifications unavailable (${err.message}). Using active polling instead.`,
        'warn'
      );
    }
  }

  _onPushEvent(event) {
    const view = event.target.value;
    if (!view || view.byteLength < 1) return;
    const code = view.getUint8(0);
    const name = PUSH_EVENTS[code] || `UNKNOWN_${code}`;
    this.log(`Mug event: ${name}`);

    switch (code) {
      case 1:
        this.readBattery();
        break;
      case 2:
        this.state.isCharging = true;
        this.emitState();
        this.readBattery();
        break;
      case 3:
        this.state.isCharging = false;
        this.emitState();
        this.readBattery();
        break;
      case 4:
        this.readTargetTemp();
        break;
      case 5:
        this.readCurrentTemp();
        break;
      case 7:
        this.readLiquidLevel();
        break;
      case 8:
        this.readLiquidState();
        break;
      default:
        break;
    }
  }

  _startPolling() {
    this._stopPolling();
    // Poll every 6 seconds to keep the BLE link alive on Google Pixel and refresh values
    this.pollTimer = setInterval(() => {
      if (this.state.connected && !this.isConnecting) {
        this.refreshAll(true).catch((err) => {
          this.log(`Keep-alive poll warning: ${err.message}`, 'warn');
        });
      }
    }, 6000);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _clearTimers() {
    this._stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _onDisconnected() {
    this._stopPolling();
    this.state.connected = false;

    if (this.manualDisconnect) {
      this.state.reconnecting = false;
      this.log('Disconnected from mug.', 'info');
      this.emitState();
      return;
    }

    this.log('Bluetooth link dropped (Pixel GATT disconnect).', 'warn');
    if (this.autoReconnect) {
      this._scheduleReconnect();
    } else {
      this.emitState();
    }
  }

  _scheduleReconnect() {
    if (this.manualDisconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.state.reconnecting = false;
      this.log('Max auto-reconnect attempts reached. Tap Reconnect to try again.', 'error');
      this.emitState();
      return;
    }

    this.reconnectAttempts += 1;
    this.state.reconnecting = true;
    this.emitState();

    // Backoff: 1.5s, 2.5s, 4s, capped at 6s
    const delayMs = Math.min(1500 + (this.reconnectAttempts - 1) * 1200, 6000);
    this.log(
      `Auto-reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${(
        delayMs / 1000
      ).toFixed(1)}s...`
    );

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connectGatt();
    }, delayMs);
  }

  async disconnect() {
    this.manualDisconnect = true;
    this._clearTimers();
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.state.connected = false;
    this.state.reconnecting = false;
    this.emitState();
  }

  async refreshAll(silent = false) {
    if (!silent) this.log('Reading mug telemetry...');
    await this.readCurrentTemp();
    await this.readTargetTemp();
    await this.readBattery();
    await this.readLiquidState();
    await this.readTempUnit();
    await this.readLedColor();
  }

  async _readChar(uuid) {
    const char = this.characteristics.get(uuid);
    if (!char) return null;
    return this.enqueueGatt(async () => {
      return await char.readValue();
    });
  }

  async _writeChar(uuid, buffer) {
    const char = this.characteristics.get(uuid);
    if (!char) throw new Error(`Characteristic ${uuid} not available on this mug`);
    return this.enqueueGatt(async () => {
      if (typeof char.writeValueWithResponse === 'function') {
        await char.writeValueWithResponse(buffer);
      } else {
        await char.writeValue(buffer);
      }
    });
  }

  /**
   * Read Current Temp (uint16 little-endian * 0.01 °C)
   */
  async readCurrentTemp() {
    try {
      const view = await this._readChar(EMBER_CHARS.CURRENT_TEMP);
      if (!view || view.byteLength < 2) return;
      const raw = view.getUint16(0, true);
      this.state.currentTempC = raw * 0.01;
      this.emitState();
    } catch (e) {
      // Ignore transient read errors during poll
    }
  }

  /**
   * Read Target Temp (uint16 little-endian * 0.01 °C)
   */
  async readTargetTemp() {
    try {
      const view = await this._readChar(EMBER_CHARS.TARGET_TEMP);
      if (!view || view.byteLength < 2) return;
      const raw = view.getUint16(0, true);
      this.state.targetTempC = raw * 0.01;
      this.emitState();
    } catch (e) {}
  }

  /**
   * Write Target Temp in Celsius (uint16 little-endian, value = round(tempC * 100))
   */
  async setTargetTempC(tempC) {
    const clampedC = Math.max(48.0, Math.min(63.0, tempC));
    const raw = Math.round(clampedC * 100);
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setUint16(0, raw, true);

    this.log(`Setting target temperature to ${clampedC.toFixed(1)}°C (${ cToF(clampedC).toFixed(0) }°F)...`);
    await this._writeChar(EMBER_CHARS.TARGET_TEMP, buffer);
    this.state.targetTempC = clampedC;
    this.emitState();
    this.log(`Target temperature updated to ${clampedC.toFixed(1)}°C.`, 'success');
  }

  /**
   * Read Battery (byte 0 = %, byte 1 = isCharging)
   */
  async readBattery() {
    try {
      const view = await this._readChar(EMBER_CHARS.BATTERY);
      if (!view || view.byteLength < 1) return;
      this.state.batteryPercent = view.getUint8(0);
      if (view.byteLength >= 2) {
        this.state.isCharging = view.getUint8(1) === 1;
      }
      this.emitState();
    } catch (e) {}
  }

  /**
   * Read Liquid State (uint8)
   */
  async readLiquidState() {
    try {
      const view = await this._readChar(EMBER_CHARS.LIQUID_STATE);
      if (!view || view.byteLength < 1) return;
      this.state.liquidState = view.getUint8(0);
      this.emitState();
    } catch (e) {}
  }

  /**
   * Read Liquid Level (uint8)
   */
  async readLiquidLevel() {
    try {
      const view = await this._readChar(EMBER_CHARS.LIQUID_LEVEL);
      if (!view || view.byteLength < 1) return;
      this.state.liquidLevel = view.getUint8(0);
      this.emitState();
    } catch (e) {}
  }

  /**
   * Read Temperature Unit (0 = C, 1 = F)
   */
  async readTempUnit() {
    try {
      const view = await this._readChar(EMBER_CHARS.TEMP_UNIT);
      if (!view || view.byteLength < 1) return;
      const unitByte = view.getUint8(0);
      this.state.unit = unitByte === 1 ? 'F' : 'C';
      this.emitState();
    } catch (e) {}
  }

  /**
   * Write Temperature Unit (0 = C, 1 = F)
   */
  async setTempUnit(unit) {
    const normalized = unit === 'F' ? 'F' : 'C';
    this.state.unit = normalized;
    this.emitState();

    if (!this.state.connected) return;
    try {
      const buffer = new Uint8Array([normalized === 'F' ? 1 : 0]).buffer;
      await this._writeChar(EMBER_CHARS.TEMP_UNIT, buffer);
      this.log(`Mug display unit set to °${normalized}`);
    } catch (err) {
      this.log(`Could not write unit to mug (requires pairing): ${err.message}`, 'warn');
    }
  }

  /**
   * Read LED Color (RGBA 4 bytes)
   */
  async readLedColor() {
    try {
      const view = await this._readChar(EMBER_CHARS.LED_COLOR);
      if (!view || view.byteLength < 3) return;
      this.state.ledColor = {
        r: view.getUint8(0),
        g: view.getUint8(1),
        b: view.getUint8(2),
        a: view.byteLength >= 4 ? view.getUint8(3) : 255,
      };
      this.emitState();
    } catch (e) {}
  }

  /**
   * Write LED Color (RGBA 4 bytes)
   */
  async setLedColor(r, g, b, a = 255) {
    const buffer = new Uint8Array([r, g, b, a]).buffer;
    await this._writeChar(EMBER_CHARS.LED_COLOR, buffer);
    this.state.ledColor = { r, g, b, a };
    this.emitState();
    this.log(`Mug LED color updated.`, 'success');
  }
}

export function cToF(c) {
  return (c * 9) / 5 + 32;
}

export function fToC(f) {
  return ((f - 32) * 5) / 9;
}
