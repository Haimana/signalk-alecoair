# Changelog

All notable changes to this project are documented in this file.

## 0.0.3

- First Node.js-only release: no Python or other system packages. The AlecoAir account login runs in the plugin and is used once, during setup, to fetch each unit's local key. After that, control stays on the boat LAN (Tuya TCP 6668).
- Several units in one plugin, each with its own LAN session, Signal K path prefix and model profile. The D13 Traditio profile is verified on a live unit; other AlecoAir families ship unverified maps; unknown units stay read-only on the `generic` profile until you map their datapoints.
- Setup lives only in Signal K Admin. The panel asks you to sign in first, then lists the units in the AlecoAir account so you can add them (a LAN scan is optional). The WebApp is for control and monitoring only.
- Signal K paths follow the device key: changing the key updates the default path prefix and the estimated power path.
- Report to GitHub, from Admin, opens a pre-filled issue for an unknown or unverified unit. The report never includes local keys, Tuya device ids, account details, LAN IPs or Signal K paths. The Tuya product id is included on purpose, as the model identifier.
