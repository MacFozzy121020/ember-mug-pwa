# Ember Control — Pixel BLE Edition (Web Bluetooth PWA)

**Live App:** [https://macfozzy121020.github.io/ember-mug-pwa/](https://macfozzy121020.github.io/ember-mug-pwa/)

A lightweight, zero-dependency Progressive Web App (PWA) for controlling your **Ember Mug** directly from Chrome on your **Google Pixel** or desktop via Web Bluetooth.

## Features
- **Live Telemetry:** Real-time liquid temperature, liquid state (*Empty, Heating, Cooling, Perfect*), battery percentage, and charging coaster detection.
- **Target Temperature & Presets:** Smooth temperature slider (`118°F–145°F` / `48°C–63°C`), `+/-` steppers, `°F` / `°C` toggle, and customizable one-tap presets (*Coffee, Black Tea, Latte, Green Tea*, plus custom presets).
- **Pixel BLE Stability Engine:**
  - Serialized GATT request queue to prevent Android BLE `GATT_ERROR` / status 133 drops.
  - Subscribes to mug push notifications (`fc540012`) alongside an active 6-second keep-alive poll so Pixel doesn't disconnect idle GATT links.
  - Automatic background reconnection if the Bluetooth connection drops.

## Hosting on GitHub Pages (Recommended for Pixel)
1. Push this repository to GitHub.
2. Go to **Settings → Pages** in your GitHub repository.
3. Under **Build and deployment**, select **Deploy from a branch** → choose `main` (root `/`) and click **Save**.
4. Open your `https://<username>.github.io/ember-mug-pwa/` URL in Chrome on your Google Pixel and select **Add to Home screen**.

## Google Pixel Setup Tips
1. **Close or uninstall the official Ember app:** The official app runs a background BLE scanner that fights for the mug's single peripheral connection.
2. **Pair/Bond once for temperature writes:** Hold the power button on the bottom of your Ember mug for **6–7 seconds** until the LED blinks **blue**, then tap **Connect Ember Mug** in this app and accept the Android pairing prompt.
3. **Still blinking blue after connecting?** Once the app shows **Connected**, press the power button on the bottom of the mug **once briefly (1 second)** to exit blue pairing mode and return the LED to normal.
