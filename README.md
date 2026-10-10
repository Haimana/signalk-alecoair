# signalk-alecoair-d13

Plugin **nativ Signal K** + WebApp pentru [ALECOAIR D13 Traditio](https://alecoair.ro/dezumidificator-alecoair-d13-traditio-13lzi) (13 L/zi, 170 W, Wi-Fi 2.4 GHz).

Nu folosește Node-RED, Home Assistant, MQTT sau cloud în calea de control. Pluginul vorbește protocolul Tuya **local** (TCP 6668) și publică starea în arborele Signal K. WebApp-ul stă în `public/` și este montat de serverul Signal K.

## De ce merge nativ

D13 Traditio (modelele cu Wi-Fi după 26.11.2021) este compatibil **AlecoAir / Smart Life / Tuya Smart**. Familia de dezumidificatoare AlecoAir cu compresor folosește aceleași datapoint-uri Tuya ca D12/D16 HOME și Shinco 30D:

| DP | Rol | Valori |
| --- | --- | --- |
| 1 | Pornit / oprit | `true` / `false` |
| 2 | Mod | `"0"` auto (higrostat), `"1"` continuu (CO / rufe) |
| 3 | Umiditate măsurată | % RH |
| 4 | Umiditate țintă | 30–80, pas 5 |
| 6 | Ventilator | `"0"` treapta II, `"1"` treapta I |
| 7 | Child lock | boolean |
| 11 | Defecte | bit 4 = dejivrare, bit 8 = rezervor plin |
| 12 | Timer | 0–24 h |
| 13 | Timp rămas | minute |
| 101 | Uscare internă (Fan Stop) | boolean |

Sleep pe panoul D13 este ventilator mic + display stins; pluginul îl expune ca comandă de conveniență (`mode: sleep` / `sleep: true`).

Manualul confirmă: implicit Manual + higrostat, CO = funcționare continuă, prag de repornire **țintă + 1% RH**, rezervor 2,3 L, 145 / 170 / 195 W în funcție de sarcină.

## Ce publică în Signal K

Prefix implicit: `environment.inside.dehumidifier`

- `environment.inside.humidity` — raport 0–1 (opțional)
- `.power`, `.mode`, `.fanSpeed`, `.targetHumidity`, `.sleep`, `.childLock`, `.insideDry` — **PUT**
- `.humidity`, `.tankFull`, `.defrost`, `.compressor`, `.electricalPower`, `.timerRemaining`
- `electrical.loads.alecoairD13.power` — wați estimați
- `notifications.environment.inside.dehumidifier.tankFull`

## Instalare pe un server Signal K

```bash
cd ~/.signalk
npm install /cale/către/signalk-alecoair-d13
# sau, după publicare: npm install signalk-alecoair-d13
```

Alternativ, din folderul pluginului:

```bash
npm install
npm link
cd ~/.signalk && npm link signalk-alecoair-d13
```

Repornește Signal K. Activează **ALECOAIR D13 Traditio** din Plugin Config.

WebApp: `http://<signalk>:3000/signalk-alecoair-d13`  
API: `http://<signalk>:3000/plugins/signalk-alecoair-d13/state`

## Cheile Tuya (o singură dată)

Controlul local cere `deviceId` + `localKey`. Nu sunt în rețea; le iei o dată din Tuya / Smart Life:

```bash
npx @tuyapi/cli wizard
```

sau `python3 -m tinytuya wizard`. Lege contul Smart Life (nu neapărat aplicația AlecoAir) de un proiect gratuit pe [iot.tuya.com](https://iot.tuya.com). După ce cheia e în config, internetul nu mai e necesar.

IP-ul e opțional dacă scanarea UDP găsește aparatul. Protocol implicit: **3.3** (D12/D16 HOME). Dacă D13-ul tău e 3.4, schimbă versiunea în config.

Pornește cu **Mod simulator** bifat ca să verifici WebApp-ul fără hardware. Debifează-l când pui ID-ul și localKey-ul reale.

## Previzualizare fără Signal K

```bash
npm install
npm start
```

Deschide `http://127.0.0.1:43147`. Simulatorul modelează higrostatul, extracția 13 L/zi, rezervorul de 2,3 L și cei 170 W.

```bash
npm test
```

## Limitări oneste

Maparea DP e cea documentată pentru familia AlecoAir/Shinco. D13 Traditio nu are încă un product_id publicat separat. WebApp-ul arată DPS-urile brute; dacă un buton nu mișcă aparatul, ajustează maparea după ce compari valorile din aplicația Tuya. Sleep nu e un DP oficial — e ventilator pe treapta I.

`signalk-tuya` existent acoperă doar prize, nu dezumidificatoare, și apelează Python. Acest plugin rămâne Node.js în procesul Signal K.
