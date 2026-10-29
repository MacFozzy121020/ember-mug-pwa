import { EmberBluetoothClient, LIQUID_STATES, cToF, fToC } from './ember-ble.js';

const DEFAULT_PRESETS = [
  { id: 'coffee', name: 'Coffee', tempC: 57.0, icon: '☕' },
  { id: 'tea', name: 'Black Tea', tempC: 60.0, icon: '🍵' },
  { id: 'latte', name: 'Latte', tempC: 54.5, icon: '🥛' },
  { id: 'green', name: 'Green Tea', tempC: 52.0, icon: '🌿' },
];

class EmberControllerApp {
  constructor() {
    this.ble = new EmberBluetoothClient();
    this.demoMode = false;
    this.demoInterval = null;
    this.displayUnit = localStorage.getItem('ember_unit') || 'F';
    this.presets = this._loadPresets();
    this.pendingTargetC = 57.0;
    this.sliderDebounce = null;
    this.swRegistration = null;
    this.waitingWorker = null;
    this.isRefreshing = false;

    this._cacheDom();
    this._bindEvents();
    this._renderPresets();
    this._updateUnitUI();
    this._renderState(this.ble.state);
    this._initServiceWorkerUpdates();

    // Attempt automatic reconnect to previously paired mug if supported
    this.ble.tryRestorePairedDevice();
  }

  _loadPresets() {
    try {
      const saved = localStorage.getItem('ember_presets');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return DEFAULT_PRESETS;
  }

  _savePresets() {
    try {
      localStorage.setItem('ember_presets', JSON.stringify(this.presets));
    } catch (e) {}
  }

  _cacheDom() {
    this.els = {
      connectBtn: document.getElementById('connect-btn'),
      connectBtnText: document.getElementById('connect-btn-text'),
      demoBtn: document.getElementById('demo-btn'),
      statusPill: document.getElementById('connection-pill'),
      statusDot: document.getElementById('status-dot'),
      statusText: document.getElementById('status-text'),
      deviceName: document.getElementById('device-name'),

      // Ring & Temperature Readout
      dialCard: document.getElementById('dial-card'),
      ringProgress: document.getElementById('ring-progress'),
      currentTempVal: document.getElementById('current-temp-value'),
      currentTempUnit: document.getElementById('current-temp-unit'),
      liquidStateBadge: document.getElementById('liquid-state-badge'),
      liquidStateText: document.getElementById('liquid-state-text'),

      // Battery & Coaster
      batteryVal: document.getElementById('battery-value'),
      batteryIcon: document.getElementById('battery-icon'),
      chargingBadge: document.getElementById('charging-badge'),
      lastSyncText: document.getElementById('last-sync-text'),

      // Target Temp Controls
      targetTempDisplay: document.getElementById('target-temp-display'),
      tempSlider: document.getElementById('temp-slider'),
      stepDownBtn: document.getElementById('step-down-btn'),
      stepUpBtn: document.getElementById('step-up-btn'),
      sliderMinLabel: document.getElementById('slider-min-label'),
      sliderMaxLabel: document.getElementById('slider-max-label'),

      // Presets
      presetsGrid: document.getElementById('presets-grid'),
      savePresetBtn: document.getElementById('save-preset-btn'),

      // Settings & Diagnostics
      unitToggleC: document.getElementById('unit-c-btn'),
      unitToggleF: document.getElementById('unit-f-btn'),
      autoReconnectToggle: document.getElementById('auto-reconnect-toggle'),
      pairingHelpBtn: document.getElementById('pairing-help-btn'),
      pairingModal: document.getElementById('pairing-modal'),
      closeModalBtn: document.getElementById('close-modal-btn'),
      logContainer: document.getElementById('ble-log'),
      clearLogBtn: document.getElementById('clear-log-btn'),

      // App Update & Refresh Controls
      updateBanner: document.getElementById('update-banner'),
      applyUpdateBtn: document.getElementById('apply-update-btn'),
      dismissUpdateBtn: document.getElementById('dismiss-update-btn'),
      refreshAppBtn: document.getElementById('refresh-app-btn'),
    };
  }

  _bindEvents() {
    // BLE state & logs
    this.ble.addEventListener('statechange', (e) => {
      if (!this.demoMode) {
        this._renderState(e.detail);
      }
    });

    this.ble.addEventListener('log', (e) => {
      this._appendLog(e.detail);
    });

    // Connect / Disconnect button
    this.els.connectBtn.addEventListener('click', async () => {
      if (this.demoMode) {
        this._stopDemoMode();
      }
      if (this.ble.state.connected || this.ble.state.reconnecting) {
        await this.ble.disconnect();
      } else {
        try {
          await this.ble.requestAndConnect();
        } catch (err) {
          // Handled in log
        }
      }
    });

    // Demo Simulator button
    this.els.demoBtn.addEventListener('click', () => {
      if (this.demoMode) {
        this._stopDemoMode();
      } else {
        this._startDemoMode();
      }
    });

    // Unit Toggle
    this.els.unitToggleC.addEventListener('click', () => this.setUnit('C'));
    this.els.unitToggleF.addEventListener('click', () => this.setUnit('F'));

    // Slider & Steppers
    this.els.tempSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.pendingTargetC = this.displayUnit === 'F' ? fToC(val) : val;
      this._updateTargetDisplay(this.pendingTargetC);
      this._highlightActivePreset(this.pendingTargetC);
    });

    this.els.tempSlider.addEventListener('change', () => {
      this._commitTargetTemp(this.pendingTargetC);
    });

    this.els.stepDownBtn.addEventListener('click', () => {
      const stepC = this.displayUnit === 'F' ? 5 / 9 : 0.5;
      const nextC = Math.max(48.0, (this.pendingTargetC || 57.0) - stepC);
      this.pendingTargetC = nextC;
      this._updateTargetDisplay(nextC);
      this._commitTargetTemp(nextC);
    });

    this.els.stepUpBtn.addEventListener('click', () => {
      const stepC = this.displayUnit === 'F' ? 5 / 9 : 0.5;
      const nextC = Math.min(63.0, (this.pendingTargetC || 57.0) + stepC);
      this.pendingTargetC = nextC;
      this._updateTargetDisplay(nextC);
      this._commitTargetTemp(nextC);
    });

    // Save current target as custom preset
    this.els.savePresetBtn.addEventListener('click', () => {
      const name = prompt('Enter a name for this temperature preset:', 'My Drink');
      if (!name || !name.trim()) return;
      const newPreset = {
        id: `custom_${Date.now()}`,
        name: name.trim().slice(0, 18),
        tempC: this.pendingTargetC || 57.0,
        icon: '✨',
      };
      this.presets.push(newPreset);
      this._savePresets();
      this._renderPresets();
      this._highlightActivePreset(this.pendingTargetC);
    });

    // Auto-reconnect toggle
    this.els.autoReconnectToggle.addEventListener('change', (e) => {
      this.ble.autoReconnect = e.target.checked;
      this.ble.log(`Pixel Auto-Reconnect ${e.target.checked ? 'enabled' : 'disabled'}.`);
    });

    // Pairing Help Modal
    this.els.pairingHelpBtn.addEventListener('click', () => {
      this.els.pairingModal.classList.remove('hidden');
    });
    this.els.closeModalBtn.addEventListener('click', () => {
      this.els.pairingModal.classList.add('hidden');
    });
    this.els.pairingModal.addEventListener('click', (e) => {
      if (e.target === this.els.pairingModal) {
        this.els.pairingModal.classList.add('hidden');
      }
    });

    // Clear Log
    this.els.clearLogBtn.addEventListener('click', () => {
      this.els.logContainer.innerHTML = '';
    });

    // Update Banner & Manual Refresh Actions
    if (this.els.applyUpdateBtn) {
      this.els.applyUpdateBtn.addEventListener('click', () => {
        this.applyPendingUpdate();
      });
    }

    if (this.els.dismissUpdateBtn) {
      this.els.dismissUpdateBtn.addEventListener('click', () => {
        this.els.updateBanner.classList.add('hidden');
      });
    }

    if (this.els.refreshAppBtn) {
      this.els.refreshAppBtn.addEventListener('click', () => {
        this.checkForUpdatesAndRefresh();
      });
    }
  }

  setUnit(unit) {
    this.displayUnit = unit === 'C' ? 'C' : 'F';
    localStorage.setItem('ember_unit', this.displayUnit);
    this._updateUnitUI();
    this._renderPresets();
    const state = this.demoMode ? this.demoState : this.ble.state;
    this._renderState(state);
    if (this.ble.state.connected) {
      this.ble.setTempUnit(this.displayUnit);
    }
  }

  _updateUnitUI() {
    const isF = this.displayUnit === 'F';
    this.els.unitToggleF.classList.toggle('active', isF);
    this.els.unitToggleC.classList.toggle('active', !isF);

    if (isF) {
      this.els.tempSlider.min = '118';
      this.els.tempSlider.max = '145';
      this.els.tempSlider.step = '1';
      this.els.sliderMinLabel.textContent = '118°F (48°C)';
      this.els.sliderMaxLabel.textContent = '145°F (63°C)';
    } else {
      this.els.tempSlider.min = '48';
      this.els.tempSlider.max = '63';
      this.els.tempSlider.step = '0.5';
      this.els.sliderMinLabel.textContent = '48°C (118°F)';
      this.els.sliderMaxLabel.textContent = '63°C (145°F)';
    }
    this._updateTargetDisplay(this.pendingTargetC);
  }

  _formatTemp(tempC) {
    if (tempC === null || tempC === undefined || Number.isNaN(tempC)) return '--';
    if (this.displayUnit === 'F') {
      return Math.round(cToF(tempC)).toString();
    }
    return tempC.toFixed(1);
  }

  _updateTargetDisplay(tempC) {
    if (tempC === null || tempC === undefined) return;
    const formatted = this._formatTemp(tempC);
    this.els.targetTempDisplay.textContent = `${formatted}°${this.displayUnit}`;
    const sliderVal = this.displayUnit === 'F' ? Math.round(cToF(tempC)) : Number(tempC.toFixed(1));
    if (document.activeElement !== this.els.tempSlider) {
      this.els.tempSlider.value = sliderVal;
    }
  }

  async _commitTargetTemp(tempC) {
    clearTimeout(this.sliderDebounce);
    this.sliderDebounce = setTimeout(async () => {
      this._highlightActivePreset(tempC);
      if (this.demoMode) {
        this.demoState.targetTempC = tempC;
        this.ble.log(`[Demo] Target temperature set to ${this._formatTemp(tempC)}°${this.displayUnit}`, 'success');
        this._renderState(this.demoState);
        return;
      }

      if (!this.ble.state.connected) {
        this.ble.log('Connect your Ember Mug first to apply target temperature.', 'warn');
        return;
      }

      try {
        await this.ble.setTargetTempC(tempC);
      } catch (err) {
        this.ble.log(
          `Failed to write target temp: ${err.message}. Put mug in pairing mode (hold bottom button for 7s until blue blink) if writing is blocked.`,
          'error'
        );
      }
    }, 180);
  }

  _renderPresets() {
    this.els.presetsGrid.innerHTML = '';
    this.presets.forEach((preset, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-card';
      btn.dataset.tempC = preset.tempC;

      const displayTemp = `${this._formatTemp(preset.tempC)}°${this.displayUnit}`;
      const isCustom = preset.id.startsWith('custom_');

      btn.innerHTML = `
        <div class="preset-top">
          <span class="preset-icon">${preset.icon}</span>
          ${isCustom ? `<span class="preset-delete" title="Remove preset" data-idx="${idx}">×</span>` : ''}
        </div>
        <div class="preset-name">${preset.name}</div>
        <div class="preset-temp">${displayTemp}</div>
      `;

      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('preset-delete')) {
          e.stopPropagation();
          this.presets.splice(idx, 1);
          this._savePresets();
          this._renderPresets();
          return;
        }
        this.pendingTargetC = preset.tempC;
        this._updateTargetDisplay(preset.tempC);
        this._commitTargetTemp(preset.tempC);
      });

      this.els.presetsGrid.appendChild(btn);
    });
    this._highlightActivePreset(this.pendingTargetC);
  }

  _highlightActivePreset(targetC) {
    const cards = this.els.presetsGrid.querySelectorAll('.preset-card');
    cards.forEach((card) => {
      const pTemp = parseFloat(card.dataset.tempC);
      const isMatch = Math.abs(pTemp - targetC) < 0.35;
      card.classList.toggle('active', isMatch);
    });
  }

  _renderState(state) {
    const isConnected = state.connected;
    const isReconnecting = state.reconnecting;

    // Status pill & button
    this.els.statusPill.className = 'status-pill';
    if (this.demoMode) {
      this.els.statusPill.classList.add('demo');
      this.els.statusText.textContent = 'Simulator Active';
      this.els.connectBtnText.textContent = 'Connect Real Mug';
      this.els.connectBtn.classList.remove('btn-danger');
    } else if (isConnected) {
      this.els.statusPill.classList.add('connected');
      this.els.statusText.textContent = 'Connected (Keep-Alive Active)';
      this.els.connectBtnText.textContent = 'Disconnect';
      this.els.connectBtn.classList.add('btn-danger');
    } else if (isReconnecting) {
      this.els.statusPill.classList.add('reconnecting');
      this.els.statusText.textContent = `Reconnecting to Pixel BLE...`;
      this.els.connectBtnText.textContent = 'Cancel Reconnect';
      this.els.connectBtn.classList.add('btn-danger');
    } else {
      this.els.statusText.textContent = 'Disconnected';
      this.els.connectBtnText.textContent = 'Connect Ember Mug';
      this.els.connectBtn.classList.remove('btn-danger');
    }

    this.els.deviceName.textContent = state.deviceName || 'Ember Mug';

    // Current Temperature
    this.els.currentTempVal.textContent = this._formatTemp(state.currentTempC);
    this.els.currentTempUnit.textContent = `°${this.displayUnit}`;

    // Target Temperature
    if (state.targetTempC !== null && state.targetTempC !== undefined) {
      this.pendingTargetC = state.targetTempC;
      this._updateTargetDisplay(state.targetTempC);
      this._highlightActivePreset(state.targetTempC);
    }

    // Liquid State & Ring Animation
    const liqInfo = LIQUID_STATES[state.liquidState] || LIQUID_STATES[0];
    this.els.liquidStateText.textContent = isConnected || this.demoMode ? liqInfo.label : 'Tap Connect to pair';
    this.els.dialCard.dataset.liquidState = isConnected || this.demoMode ? liqInfo.stateClass : 'idle';

    // Ring gauge progress (35°C to 65°C range mapped to SVG stroke-dashoffset)
    const circumference = 2 * Math.PI * 110; // r=110 => ~691.15
    if ((isConnected || this.demoMode) && state.currentTempC !== null) {
      const normalized = Math.max(0, Math.min(1, (state.currentTempC - 30) / (65 - 30)));
      const offset = circumference * (1 - normalized);
      this.els.ringProgress.style.strokeDashoffset = `${offset}`;
    } else {
      this.els.ringProgress.style.strokeDashoffset = `${circumference}`;
    }

    // Battery
    if (state.batteryPercent !== null && state.batteryPercent !== undefined) {
      this.els.batteryVal.textContent = `${state.batteryPercent}%`;
    } else {
      this.els.batteryVal.textContent = '--%';
    }
    this.els.chargingBadge.classList.toggle('hidden', !state.isCharging);

    // Last sync timestamp
    if (state.lastUpdated) {
      this.els.lastSyncText.textContent = `Synced ${state.lastUpdated.toLocaleTimeString()}`;
    } else {
      this.els.lastSyncText.textContent = 'Not synced yet';
    }
  }

  _startDemoMode() {
    this.demoMode = true;
    this.els.demoBtn.textContent = 'Exit Simulator';
    this.els.demoBtn.classList.add('active');

    this.demoState = {
      connected: true,
      reconnecting: false,
      deviceName: 'Ember Mug² (Simulator)',
      currentTempC: 54.2,
      targetTempC: 57.0,
      unit: this.displayUnit,
      batteryPercent: 86,
      isCharging: false,
      liquidState: 5, // Heating
      lastUpdated: new Date(),
    };

    this.ble.log('Started interactive Ember Mug simulator.', 'info');
    this._renderState(this.demoState);

    this.demoInterval = setInterval(() => {
      if (!this.demoMode) return;
      const diff = this.demoState.targetTempC - this.demoState.currentTempC;
      if (Math.abs(diff) < 0.25) {
        this.demoState.currentTempC = this.demoState.targetTempC;
        this.demoState.liquidState = 6; // Perfect
      } else if (diff > 0) {
        this.demoState.currentTempC += 0.35;
        this.demoState.liquidState = 5; // Heating
      } else {
        this.demoState.currentTempC -= 0.35;
        this.demoState.liquidState = 4; // Cooling
      }
      this.demoState.lastUpdated = new Date();
      this._renderState(this.demoState);
    }, 1500);
  }

  _stopDemoMode() {
    this.demoMode = false;
    if (this.demoInterval) {
      clearInterval(this.demoInterval);
      this.demoInterval = null;
    }
    this.els.demoBtn.textContent = 'Try Simulator';
    this.els.demoBtn.classList.remove('active');
    this.ble.log('Exited simulator mode.', 'info');
    this._renderState(this.ble.state);
  }

  _appendLog(entry) {
    const row = document.createElement('div');
    row.className = `log-row log-${entry.level}`;
    row.innerHTML = `<span class="log-time">[${entry.timestamp}]</span> <span class="log-msg">${entry.message}</span>`;
    this.els.logContainer.prepend(row);
  }

  async _initServiceWorkerUpdates() {
    if (!('serviceWorker' in navigator)) return;

    const hadController = Boolean(navigator.serviceWorker.controller);

    // Listen for messages from sw.js (new version activated or notification clicked)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (!event.data) return;
      if (event.data.type === 'SW_UPDATED' && hadController) {
        this._onNewWorkerWaiting(null);
      } else if (event.data.type === 'APPLY_UPDATE') {
        this.applyPendingUpdate();
      }
    });

    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      this.swRegistration = reg;

      // If an updated worker is waiting
      if (reg.waiting && hadController) {
        this._onNewWorkerWaiting(reg.waiting);
      }

      // Detect newly installed workers
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && hadController) {
            this._onNewWorkerWaiting(newWorker);
          }
        });
      });

      // Automatically check for updates when user returns to the app tab/PWA
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => {});
        }
      });

      // Periodic update check every 5 minutes
      setInterval(() => {
        reg.update().catch(() => {});
      }, 5 * 60 * 1000);
    } catch (err) {
      // Service worker registration failed or unsupported context
    }
  }

  _onNewWorkerWaiting(worker) {
    if (worker) {
      this.waitingWorker = worker;
    }
    if (this.els.updateBanner && !this.els.updateBanner.classList.contains('hidden')) {
      return; // Banner already visible
    }
    if (this.els.updateBanner) {
      this.els.updateBanner.classList.remove('hidden');
    }
    this.ble.log('A new app update is ready! Tap "Refresh Now" to update.', 'success');

    // Also fire a system notification if permission was granted
    if ('Notification' in window && Notification.permission === 'granted' && this.swRegistration) {
      this.swRegistration
        .showNotification('Ember Control Update Ready', {
          body: 'Tap to refresh the app to the latest version.',
          icon: './icon.svg',
          tag: 'ember-app-update',
        })
        .catch(() => {});
    }
  }

  applyPendingUpdate() {
    if (this.waitingWorker) {
      this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(() => {
        if (!this.isRefreshing) {
          this.isRefreshing = true;
          window.location.reload();
        }
      }, 600);
    } else {
      window.location.reload();
    }
  }

  async checkForUpdatesAndRefresh() {
    if (this.els.refreshAppBtn) {
      this.els.refreshAppBtn.classList.add('spinning');
    }
    this.ble.log('Checking for app updates...');

    // Request notification permission if not asked yet so future updates can alert the user
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    try {
      if (this.swRegistration) {
        await this.swRegistration.update();
      }
    } catch (e) {
      // Ignore network errors and reload anyway
    }

    window.location.reload();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.emberApp = new EmberControllerApp();
});
