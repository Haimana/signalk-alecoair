# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 (unreleased)

- External sensor control, per unit and off by default: the plugin can drive a unit from another Signal K humidity sensor (one or several paths, highest or average). The unit is put in its continuous mode (CO on the Traditio) and switched on at target + 3% and off at target − 2%, with minimum on and off times (10 min each). No power-off during defrost; a full tank is left to the firmware. A manual change on the unit pauses the controller for 60 min. When the sensor goes stale, the unit gets its own hygrostat back (or is switched off, if you choose). Optional temperature path: the unit is not started below a minimum temperature (default 5 °C). Everything is adjustable in Admin → External control, with picklists of the server's humidity and temperature paths.
- WebApp: when external control is allowed for a unit, its working-mode menu gets one more entry, **Auto / external sensor** (shown as the selected mode while it is on, although the unit itself is in CO). Picking any other mode leaves external control and sets that mode. While it is on, the ring shows the external humidity, −/+ change the controller target in the unit's hygrostat steps (5%, 30–80% on the Traditio) and a status line shows what the controller is doing. Targets set over the API or Signal K are snapped to the same steps.
- Signal K: `<prefix>.control.mode` and `<prefix>.control.target` (PUT), plus `control.state`, `control.reason`, `control.sourceHumidity` and `control.sourceTemperature`. REST: `POST /plugins/signalk-alecoair/devices/<key>/control`.
- Test hook for a simulated sensor: `plugin-config-data/signalk-alecoair.test-sensor.json` publishes `environment.inside.test.*` values while the file exists.

## 0.0.3

- First Node.js-only release: no Python or other system packages. The AlecoAir account login runs in the plugin and is used once, during setup, to fetch each unit's local key. After that, control stays on the boat LAN (Tuya TCP 6668).
- Several units in one plugin, each with its own LAN session, Signal K path prefix and model profile. The D13 Traditio profile is verified on a live unit; other AlecoAir families ship unverified maps; unknown units stay read-only on the `generic` profile until you map their datapoints.
- Setup lives only in Signal K Admin. The panel asks you to sign in first, then lists the units in the AlecoAir account so you can add them (a LAN scan is optional). The WebApp is for control and monitoring only.
- Signal K paths follow the device key: changing the key updates the default path prefix and the estimated power path.
- Report to GitHub, from Admin, opens a pre-filled issue for an unknown or unverified unit. The report never includes local keys, Tuya device ids, account details, LAN IPs or Signal K paths. The Tuya product id is included on purpose, as the model identifier.
