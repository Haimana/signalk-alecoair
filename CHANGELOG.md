# Changelog

All notable changes to this project are documented in this file.

## 0.0.5 (2026-11-14)

- WebApp: the external temperature sensor (Admin → External control → Temperature path) is shown in the centre of the gauge, as a line under the current humidity with a thermometer glyph, about the same size, one decimal. It shows in every mode, not only while External runs, and is hidden when there is no path or the value is missing or older than the sensor-lost time. It hangs absolutely under the humidity line, so the big target and the layout do not move.
- Temperature unit from Signal K: the plugin converts with the server's unit preferences for that path (`app.getDisplayUnits` / `app.convertToDisplayUnits`, Signal K 2.x, i.e. the active preset: °C, °F or K); °C when the server has none.
- Plugin: the device state (`GET /devices/<key>/state`) has `sensorTemperature: { path, value, unit, unitSource ('signalk' | 'default'), celsius, at }` or `null`, read from Signal K on every request, so it is there whether or not external control is running.
- WebApp: a click or tap on the gauge no longer shows a focus ring around it or selects text; only a press on the arc moves the target (a press in the centre still does nothing). The focus ring stays for keyboard use.
- App Store / Admin Webapps icon: `signalk.appIcon` is now `./icon.svg`. Admin resolves it against the WebApp root (`public/`), so `./public/icon.svg` gave a 404. `icon.svg` is also published at the package root for the App Store's icon lookup.

## 0.0.4 (2026-11-13)

### External sensor control

- New, per unit and off by default: the plugin can drive a unit from another Signal K humidity sensor, for example a BME280 in the saloon. One sensor path per unit; several units may share a sensor. Set it up in Admin → **External control**, with picklists of the server's humidity and temperature paths.
- The unit is put in its continuous mode (CO on the Traditio) and switched on at target + 3% and off at target − 2%, with minimum on and off times (10 min each). All of these are adjustable. A profile without a continuous mode uses its lowest hygrostat target plus power on/off.
- No power-off during defrost. A full tank is left to the firmware.
- A change on the unit that the controller did not make (the unit's buttons, the AlecoAir app, the WebApp power button, a Signal K PUT) switches external control off at once and leaves the unit as it is. Pick **External** again to resume. The manual-change pause of the first drafts is gone.
- When the sensor goes stale (5 min), the unit gets its own hygrostat back (or is switched off, if you choose). Optional temperature path: the unit is not started below a minimum temperature (default 5 °C).
- The External target is separate from the unit's own hygrostat target. It is kept between sessions and moves in the unit's hygrostat steps (5%, 30–80% on the Traditio); targets set over the API or Signal K are snapped the same way.
- After a restart the controller resumes with the same target, the same on/off choice and the minimum times counted from the last switch.
- Signal K: `<prefix>.control.mode` and `<prefix>.control.target` (PUT), plus `control.state`, `control.reason`, `control.sourceHumidity` and `control.sourceTemperature`. REST: `POST /plugins/signalk-alecoair/devices/<key>/control`. `PUT <prefix>.mode` = `external` switches it on too.
- A humidity-path list saved by an earlier development draft is read as its first path.
- Test hook for a simulated sensor: `plugin-config-data/signalk-alecoair.test-sensor.json` publishes `environment.inside.test.*` values while the file exists.

### WebApp

- New dark-glass design: one card per unit, the same on every model.
  - Desktop: a 270° gauge on the left (a thin track, a brighter arc up to the current humidity, the knob on the target; tap or drag to set it) with the big target and the current humidity in its centre, and − / + next to it.
  - On the right: the working modes as icon buttons (**External** included when it is allowed), the fan speed under them if the unit has one, and the status as text labels (Compressor, Defrost, Tank full in red, Child lock, Timer, Sleep, Inside dry). Lit = active, dim = inactive.
  - The gauge sits at the same place on every card. The modes are centred in the rest of the card, and the status line is level with the bottom of the gauge.
  - Phone: gauge, − / +, modes, fan and status stacked and centred.
- One message line per card (errors, offline, tank full, defrost, sensor warnings). It never moves the layout: one line with the full text in the tooltip on desktop, two lines on a phone. A lost connection to the plugin shows as a toast at the top of the page, also when the server answers with an HTTP error.
- External: the gauge shows the external humidity (antenna icon) and −/+ change the controller target. The controller's state is in the External button's tooltip; warnings go to the message line.
- Admin, per unit: **Show child lock in UI** and **Show timer in UI**, both off by default. When off, the card hides those labels (and the timer stepper). Signal K data and PUT are not affected.
- Cards are built once and only updated on refresh, so nothing flickers and the focus stays put. A tap shows at once, and −/+ send one command once the taps stop.

## 0.0.3

- First Node.js-only release: no Python or other system packages. The AlecoAir account login runs in the plugin and is used once, during setup, to fetch each unit's local key. After that, control stays on the boat LAN (Tuya TCP 6668).
- Several units in one plugin, each with its own LAN session, Signal K path prefix and model profile. The D13 Traditio profile is verified on a live unit; other AlecoAir families ship unverified maps; unknown units stay read-only on the `generic` profile until you map their datapoints.
- Setup lives only in Signal K Admin. The panel asks you to sign in first, then lists the units in the AlecoAir account so you can add them (a LAN scan is optional). The WebApp is for control and monitoring only.
- Signal K paths follow the device key: changing the key updates the default path prefix and the estimated power path.
- Report to GitHub, from Admin, opens a pre-filled issue for an unknown or unverified unit. The report never includes local keys, Tuya device ids, account details, LAN IPs or Signal K paths. The Tuya product id is included on purpose, as the model identifier.
