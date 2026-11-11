# signalk-alecoair

Native Signal K plugin and WebApp for AlecoAir Wi-Fi dehumidifiers. Several units, one LAN connection each, data-driven model profiles.

Control stays on the boat LAN (Tuya TCP 6668). No Node-RED, Home Assistant, MQTT, or cloud in the command path. The AlecoAir account is used once during setup to fetch each unit's local key.

- **Setup** lives only in Signal K Admin: **Server → Plugin Config → AlecoAir**.
- **The WebApp** is only for operating the units: `http://<signalk>:3000/signalk-alecoair/`

> Renamed from `signalk-alecoair-d13`. See [Migrating from signalk-alecoair-d13](#migrating-from-signalk-alecoair-d13).

## Supported models

Every Wi-Fi AlecoAir unit is a Tuya dehumidifier (category `cs`), so the LAN transport is the same. The datapoint (DP) layout is not, so each family has a profile. The profile is picked from the Tuya product id that the AlecoAir login returns, or chosen by hand in Plugin Config.

| Profile | Models | Status |
| --- | --- | --- |
| `traditio` | D13 Traditio, D25 Traditio | **Verified** on a live D13 (Tuya LAN 3.5). D25 shares the map per tuya-local, not tested here. |
| `shinco-home` | D12 Home, D16 Home (Shinco family) | Unverified community map (make-all/tuya-local) |
| `d12-eco` | D12 ECO 2.0 | Unverified community map |
| `d16-purify` | D16 Purify (D14 Purify) | Unverified community map |
| `generic` | anything else | Read-only until you map DPs in the inspector |

A unit whose product id matches no profile is **never** given the D13 map. It runs read-only on `generic`; Plugin Config shows what its DPs look like and lets you pick a profile or map DPs yourself.

The plugin only exposes controls that the profile maps **and** the unit actually reports, and it never writes a DP the unit has not reported.

## Setup (Signal K Admin)

1. Install the plugin (see [Install](#install)), restart Signal K and enable **AlecoAir dehumidifiers** in **Server → Plugin Config**.
2. In the plugin's panel, under **AlecoAir account**, sign in with the email or phone and password of the **AlecoAir app** where your units already appear. Pick the region (`eu` for Romania/Europe). For a phone login, set the country code (default `40`).
   The password is used once and is not stored. The plugin keeps each unit's local key in its own store on the Signal K server, never in the Admin-visible options.
3. The account's devices are listed with their product id and matching profile. Click **Add** for each dehumidifier.
4. Optional: **Scan LAN** to find the units. Leave **LAN IP** empty to let the plugin find the unit at start, or fill it in: an IP set here always wins.
5. Check the device key (used in paths and the API), the profile, the model (for the power estimate) and the Signal K paths, then **Save configuration**. Saving restarts the plugin.
6. Open **DP inspector** on a running device to see its live DPs. Change a setting on the unit itself and watch which DP changes, then map it to a role. Save to apply the overrides.

Sign in again whenever you re-pair a unit in the AlecoAir app: re-pairing changes its local key. **Forget account** drops the device list but keeps the keys of devices that are still configured.

Python 3 with `requests` is needed for the login (see [Install](#install)). Nothing else in the plugin uses Python.

### Configurator and older servers

The setup panel is a Signal K plugin configurator (`signalk-plugin-configurator`, Module Federation `./PluginConfigurationPanel`), written without a build step: `public/remoteEntry.js` uses the Admin UI's own React. It was built against signalk-server 2.37 (React 19 Admin UI). Servers that do not load configurators fall back to the generic JSON form from the plugin schema, which can edit the device list but cannot sign in or inspect DPs.

## WebApp

`http://<signalk>:3000/signalk-alecoair/` operates the configured units: power, mode, target humidity, timer, child lock and whatever else the unit has. With more than one unit a switcher appears at the top; `?device=<key>` opens a specific unit. There is no setup in the WebApp.

## Signal K paths

Each device has its own prefix. Units added in Admin default to `environment.inside.dehumidifier.<key>`. A unit migrated from `signalk-alecoair-d13` keeps `environment.inside.dehumidifier`, so existing dashboards keep working.

Under the prefix, only paths the unit actually has are published:

- `.connected`
- `.power`, `.mode`, `.targetHumidity`, `.fanSpeed`, `.childLock`, `.timerHours`, `.sleep`, `.insideDry`: **PUT**
- `.humidity` (ratio 0–1), `.temperature` (K), `.tankFull`, `.defrost`, `.faultCode`, `.timerRemaining` (s), `.compressor` (estimated)
- `.electricalPower` (W, estimated, only when the model's nameplate is known)
- `notifications.<prefix>.tankFull`

`.mode` has `possibleValues` metadata (e.g. `auto`, `continuous`, `sleep` on Traditio). Optional per device: an estimated power path (default `electrical.loads.dehumidifier<Key>.power`) and a cabin humidity path (off by default for new units).

## Install

The package is not on npm. On the Signal K server:

```bash
git clone https://github.com/Haimana/signalk-alecoair.git ~/signalk-alecoair
cd ~/signalk-alecoair
npm install --omit=dev
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Link it into Signal K. The entry in `~/.signalk/node_modules` **must be named `signalk-alecoair`**, because Signal K loads plugins and mounts webapps by package name:

```bash
cd ~/.signalk
npm install ../signalk-alecoair   # adds "signalk-alecoair": "file:../signalk-alecoair" to package.json
```

Restart Signal K, then follow [Setup](#setup-signal-k-admin).

API: `http://<signalk>:3000/plugins/signalk-alecoair/devices` (see `openapi.json`).

## Migrating from signalk-alecoair-d13

What the plugin does by itself on its first start as `signalk-alecoair`:

- reads `~/.signalk/plugin-config-data/signalk-alecoair-d13.store.json` (local key, adopted device, protocol) and writes `signalk-alecoair.store.json` (mode 0600);
- turns the old flat options, from Signal K's options or from `signalk-alecoair-d13.json`, into one device with key `d13`, profile `traditio`, model `D13`, and the old paths (`environment.inside.dehumidifier`, `electrical.loads.alecoairD13.power`, `environment.inside.humidity`). The IP the old plugin was actually using is carried over; from then on, the IP in Plugin Config is the only one that counts;
- saves the new options as `signalk-alecoair.json`. The old files are left untouched as a backup.

For a `file:`-linked install, such as `~/.signalk/package.json` containing `"signalk-alecoair-d13": "file:../signalk-alecoair-d13"`:

```bash
sudo systemctl stop signalk

# 1. Backups
cp -a ~/signalk-alecoair-d13 ~/signalk-alecoair-d13.bak
cp -a ~/.signalk/plugin-config-data ~/.signalk/plugin-config-data.bak
cp ~/.signalk/package.json ~/.signalk/package.json.bak

# 2. New code next to the old one (copy of this repository, without .git)
#    then its dependencies; reuse the old Python venv or create a new one
cd ~/signalk-alecoair && npm install --omit=dev
cp -a ~/signalk-alecoair-d13/.venv ~/signalk-alecoair/.venv   # or: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 3. Point Signal K at the new package name
cd ~/.signalk
sed -i 's#"signalk-alecoair-d13": "file:../signalk-alecoair-d13"#"signalk-alecoair": "file:../signalk-alecoair"#' package.json
rm node_modules/signalk-alecoair-d13
ln -s ../../signalk-alecoair node_modules/signalk-alecoair

# 4. Keep the plugin enabled (the old flat config is migrated on start)
cp plugin-config-data/signalk-alecoair-d13.json plugin-config-data/signalk-alecoair.json

sudo systemctl start signalk
```

Then open Admin → Plugin Config → AlecoAir: device `d13` should be connected, with "Migrated from …" at the top. The WebApp moved from `/signalk-alecoair-d13/` to `/signalk-alecoair/`, and the REST base from `/plugins/signalk-alecoair-d13` to `/plugins/signalk-alecoair`. Signal K paths do not change.

Do not keep both packages installed: two plugins would fight over the same unit's single LAN session.

To roll back: stop Signal K, restore `package.json.bak`, replace the `node_modules/signalk-alecoair` link with `ln -s ../../signalk-alecoair-d13 node_modules/signalk-alecoair-d13`, and start again. The old plugin's config and store files were not modified.

## Traditio datapoints (D13, verified)

D13 Traditio talks Tuya protocol **3.5** on the LAN. The cloud often returns a WAN IP; the plugin keeps only RFC 1918 addresses.

| DP | Role | Values |
| --- | --- | --- |
| 1 | Power | `true` / `false` |
| 2 | Target humidity | 30–80 step 5; Continuous (CO) is `25` |
| 5 | Mode | `Manual` (hygrostat/CO), `SLeeping` |
| 6 | Measured humidity | % RH |
| 16 | Child lock | boolean |
| 17 | Timer | `cancel`, `1h`…`24h` |
| 19 | Faults | bit 4 = tank full, bit 8 = defrost |

The live D13 reports only these seven DPs. The Traditio profile also maps fan speed to DP 4 (present on the D25 per tuya-local), but it stays hidden on a D13 because the D13 never reports DP 4.

Manual defaults: Manual + hygrostat, CO = continuous via target `25`, restart threshold **target + 1% RH**, 2.3 L tank, 145 / 170 / 195 W.

## Security notes

- Local keys are stored in plaintext in `~/.signalk/plugin-config-data/signalk-alecoair.store.json` (file mode 0600). They are never sent to the browser.
- The setup API (`/plugins/signalk-alecoair/setup/*`) is admin-only when Signal K security is on. The usage API needs read or read/write access.
- `plugin/alecoair-helper.py` uses the AlecoAir app's public Tuya client id. If the vendor rotates it, login breaks; LAN control keeps working with the keys already stored.

## Development

```bash
npm test
```

Tests use `node --test` and need no hardware: fake Tuya LAN devices, the simulator, and a fake Signal K app. Add a profile in `plugin/profiles.js`; mark it `verified: false` until it has been tested on a real unit.

## Limits

The existing `signalk-tuya` covers sockets, not dehumidifiers. This plugin runs in the Signal K Node.js process. Tuya units allow very few LAN sessions: do not run Home Assistant / tuya-local against the same unit at the same time.
