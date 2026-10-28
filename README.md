# signalk-alecoair-d13

Native Signal K plugin and WebApp for the [ALECOAIR D13 Traditio](https://alecoair.ro/dezumidificator-alecoair-d13-traditio-13lzi) (13 L/day, 170 W, 2.4 GHz Wi-Fi).

Control stays on the boat LAN (Tuya TCP 6668). No Node-RED, Home Assistant, MQTT, or cloud in the command path.

## Setup

1. Install and enable **ALECOAIR D13 Traditio** in Signal K Plugin Config.
2. Open the WebApp: `http://<signalk>:3000/signalk-alecoair-d13`
3. In Smart Life: **Me** → gear → **Account and Security** → copy **User Code**.
4. Generate the QR in the WebApp.
5. Stay on **Me** and tap the **scan icon** next to the gear. Do **not** use **+** / Add device.
6. Confirm **login**. The plugin stores the device key and connects locally.

After that, internet is not required for control.

## Signal K paths

Default prefix: `environment.inside.dehumidifier`

- `environment.inside.humidity` — ratio 0–1 (optional)
- `.power`, `.mode`, `.fanSpeed`, `.targetHumidity`, `.sleep`, `.childLock`, `.insideDry` — **PUT**
- `.humidity`, `.tankFull`, `.defrost`, `.compressor`, `.electricalPower`, `.timerRemaining`
- `electrical.loads.alecoairD13.power` — estimated watts
- `notifications.environment.inside.dehumidifier.tankFull`

## Install

```bash
cd ~/.signalk
npm install /path/to/signalk-alecoair-d13
```

Or from the plugin folder:

```bash
npm install
npm link
cd ~/.signalk && npm link signalk-alecoair-d13
```

Restart Signal K. Enable the plugin. Smart Life login also needs Python 3 and `requirements.txt` in a plugin `.venv`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

API: `http://<signalk>:3000/plugins/signalk-alecoair-d13/state`

```bash
npm test
```

## Tuya datapoints

D13 Traditio Wi-Fi talks Tuya protocol **3.5** on LAN. Cloud often returns a WAN IP; the plugin keeps only RFC1918 addresses.

| DP | Role | Values |
| --- | --- | --- |
| 1 | Power | `true` / `false` |
| 2 | Target humidity | 30–80 step 5; Continuous uses `25` (CO) |
| 5 | Mode | `Manual` (hygrostat/CO), `SLeeping` |
| 6 | Measured humidity | % RH |
| 16 | Child lock | boolean |
| 17 | Timer | `cancel`, `1h`…`24h` |
| 19 | Faults | bit 4 = defrost, bit 8 = tank full |

Live LAN schema on D13 Traditio exposes only these seven DPs. Fan speed and inside-dry are not on the wire.

Manual defaults: Manual + hygrostat, CO = continuous via target `25`, restart threshold **target + 1% RH**, 2.3 L tank, 145 / 170 / 195 W.

## Limits

Existing `signalk-tuya` covers sockets, not dehumidifiers. This plugin stays in the Signal K Node.js process for LAN control. AlecoAir OEM login is used once to fetch the local key.
