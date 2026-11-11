# signalk-alecoair

Signal K plugin and WebApp for AlecoAir Wi-Fi dehumidifiers over Tuya LAN: several units, model profiles, setup in Signal K Admin, no cloud or Node-RED in the control path.

- **Local control.** Each unit is driven over the boat LAN with the Tuya LAN protocol (TCP 6668), protocol 3.5 with automatic fallback 3.5 → 3.4 → 3.3. No Tuya cloud, Node-RED, Home Assistant or MQTT in the command path. The AlecoAir account is used only during setup, to fetch each unit's local key.
- **Several units, one plugin.** Every unit has its own LAN session, Signal K path prefix and model profile (which datapoints, modes and settings it has).
- **Setup only in Signal K Admin**, in the plugin's own configurator: **Server → Plugin Config → AlecoAir dehumidifiers**.
- **The WebApp is for use only**: control and monitoring at `http://<signalk>:3000/signalk-alecoair/`.

> Version 2.0.0. Renamed from `signalk-alecoair-d13`; an existing D13 install is migrated automatically, see [Migrating from signalk-alecoair-d13](#migrating-from-signalk-alecoair-d13). Not published on npm: install from GitHub as shown below.

**Not included yet:** native widgets for SKIP and automations that drive a unit from another Signal K humidity path (or start a heater). Both are on the roadmap; the plugin today controls and monitors the units you configure.

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

## Install

### Requirements

- A Signal K server (built and tested on signalk-server 2.37) with Node.js 18 or newer.
- Python 3 on the server, used only for the AlecoAir account login that fetches the local keys.
- The dehumidifiers already paired in the **AlecoAir app**, and on the same LAN as the Signal K server.
- The AlecoAir account email (or phone) and password. You do not need to hunt for Tuya device ids or local keys yourself: the plugin reads them from the account when you sign in, once, in Admin.

### Steps

The package is not on npm. On the Signal K server:

```bash
# 1. Get the code and its dependencies
git clone https://github.com/Haimana/signalk-alecoair.git ~/signalk-alecoair
cd ~/signalk-alecoair
npm install --omit=dev
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. Install it into Signal K (adds "signalk-alecoair": "file:../signalk-alecoair" to ~/.signalk/package.json)
cd ~/.signalk
npm install ../signalk-alecoair

# 3. Restart Signal K
sudo systemctl restart signalk
```

The entry in `~/.signalk/node_modules` **must be named `signalk-alecoair`**: Signal K loads plugins and mounts webapps by package name.

To update later: `cd ~/signalk-alecoair && git pull && npm install --omit=dev`, then restart Signal K.

## Configure (Signal K Admin)

1. Open Signal K Admin → **Server → Plugin Config → AlecoAir dehumidifiers** and enable the plugin.
2. Under **AlecoAir account**, enter the **Email or phone** and **Password** of the AlecoAir app where your units appear, pick the **Region** (`eu` for Europe) and, for a phone login, the **Country code** (default `40`). Click **Sign in**.
   The password is used once and never stored. After a successful sign-in the email or phone is kept so the panel can show the linked account. Local keys go to the plugin's own store on the server, never into the Admin-visible options.
3. The account's devices are listed with their product id and suggested profile. Click **Add** for each dehumidifier you want.
4. Optional: **Scan LAN** to find the units on the network. Leave **LAN IP** empty to let the plugin find the unit at start, or fill it in: an IP set here always wins.
5. For each unit, check:
   - **Name** and **Key (paths and API)**;
   - **Model profile**: *Auto (by AlecoAir product id)* or a profile from the table below;
   - **Model (power estimate)**, if known;
   - **Signal K path prefix** (default `environment.inside.dehumidifier.<key>`), the optional estimated power path and cabin humidity path.
6. Click **Save configuration**. Saving restarts the plugin; each unit shows *Connected* once its LAN session is up.
7. Optional: open **DP inspector** on a running unit to see its live datapoints and map unknown ones to roles (useful for unverified or `generic` units).

Sign in again whenever you re-pair a unit in the AlecoAir app: re-pairing changes its local key. **Forget account** drops the device list but keeps the keys of devices that are still configured. **Remove** deletes a unit from the configuration. **Add simulator** adds a fake unit for trying the plugin without hardware.

Adding or removing units, credentials and profiles are only in Admin, never in the WebApp.

### Configurator and older servers

The setup panel is a Signal K plugin configurator (`signalk-plugin-configurator`, Module Federation `./PluginConfigurationPanel`), written without a build step: `public/remoteEntry.js` uses the Admin UI's own React. It was built against signalk-server 2.37 (React 19 Admin UI). Servers that do not load configurators fall back to the generic JSON form from the plugin schema, which can edit the device list but cannot sign in or inspect DPs.

## Using the WebApp

Open `http://<signalk>:3000/signalk-alecoair/` (also listed under **Webapps** in Signal K Admin). Every configured unit gets its own card, stacked one under another; `?device=<key>` scrolls to a given unit. The look is inspired by the AlecoAir app, not a copy of it.

Each card shows the unit's real modes for its profile and only the controls the unit actually reports: power, working mode, target humidity, timer, child lock and so on. The D13 Traditio has no fan control, so none is shown for it.

- **Phone / narrow screens (< 960 px):** a compact card per unit with the mode, the humidity ring and −/+ for the target, and a bottom bar (Power, Mode, Fan if present, Settings). Mode, Fan and Settings open a bottom sheet.
- **Desktop (≥ 960 px):** one wide card per unit, stacked vertically. Left: name, status, humidity ring and −/+. Right: Power, the working mode as a dropdown (with fan speed on the same row if the unit has a fan) and the settings in a fixed two-column area. All cards have the same height whatever the model, so units line up and an odd number of units leaves no stray card. Alerts (tank full, defrost, unit not responding) can still make a card taller while they are active.

UI labels are in English.

## Signal K paths

Each device has its own prefix. Units added in Admin default to `environment.inside.dehumidifier.<key>`. A unit migrated from `signalk-alecoair-d13` keeps `environment.inside.dehumidifier`, so existing dashboards keep working.

Under the prefix, only paths the unit actually has are published:

- `.connected`
- `.power`, `.mode`, `.targetHumidity`, `.fanSpeed`, `.childLock`, `.timerHours`, `.sleep`, `.insideDry`: **PUT**
- `.humidity` (ratio 0–1), `.temperature` (K), `.tankFull`, `.defrost`, `.faultCode`, `.timerRemaining` (s), `.compressor` (estimated)
- `.electricalPower` (W, estimated, only when the model's nameplate is known)
- `notifications.<prefix>.tankFull`

`.mode` has `possibleValues` metadata (e.g. `auto`, `continuous`, `sleep` on Traditio). Optional per device: an estimated power path (default `electrical.loads.dehumidifier<Key>.power`) and a cabin humidity path (off by default for new units).

## API

`http://<signalk>:3000/plugins/signalk-alecoair/devices` lists the units and their state (see `openapi.json`). The setup endpoints (`/plugins/signalk-alecoair/setup/*`) are admin-only.

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

Tests use `node --test` and need no hardware: fake Tuya LAN devices, the simulator, and a fake Signal K app. Add a profile in `plugin/profiles.js`; mark it `verified: false` until it has been tested on a real unit. Reports and DP maps for the unverified profiles are welcome.

## Limits

The existing `signalk-tuya` covers sockets, not dehumidifiers. This plugin runs in the Signal K Node.js process. Tuya units allow very few LAN sessions: do not run Home Assistant / tuya-local (or the old `signalk-alecoair-d13`) against the same unit at the same time.

## License

Apache-2.0
