# myIO API-referencia

**Cél:** ez a dokumentum önmagában elegendő ahhoz, hogy egy fejlesztő vagy AI-asszisztens
klienst (mobil-/webalkalmazást, scriptet, okosotthon-integrációt) készítsen egy myIO
vezérlőhöz. API-szint: `info.json` → `"api": 3`.

> **Verzió-jelölés.** Két aktuális firmware van: **3.12.2** (Arduino Due) és **4.3.2**
> (Arduino GIGA). Az alap a 3.12.2: minden **jelöletlen** funkció mindkét firmware-ben él.
> A **[4.x]** jelű funkciók csak a 4.x (GIGA) firmware-ben érhetők el; ha egy funkció egy
> konkrét verzióban jelent meg, azt írjuk ki (pl. **[4.2+]**). Ha a jövőben egy funkció
> kikerül, azt **[−<verzió>]** jelöli (attól a verziótól már nem elérhető). A kliens a
> `version` mezőből (`info.json`) döntsön képességekről.

---

## 1. Áttekintés, transzportok

| Csatorna | Port | Mire való |
|---|---|---|
| **HTTP** | 80 | Web UI, JSON-lekérdezések, `command:` vezérlés, fájl fel-/letöltés, Shelly-webhook |
| **App-socket** (nyers TCP, soronkénti protokoll) | 843 | Mobilalkalmazás: tömör állapot-sorok + ugyanazok a JSON-ok HTTP-fejléc nélkül |
| **Soros port** (USB / kijelző-UART) | 115200 | `?parancs.` / `!parancs.` keretezés; admin-szintű |
| **UDP broadcast** (kimenő) | 17000 | Relé-állapot hirdetés a helyi hálózatra |

Fontos alapok:

- **Nincs TLS** — csak helyi hálózatra tervezve.
- HTTP/1.1, minden válasz `Connection: close`. **Ne** használj keep-alive-ot.
- A vezérlőnek kevés párhuzamos socketje van (3 HTTP listen-socket). Kliensből **egyszerre
  legfeljebb 1-2 kérést** futtass, a pollozást ne vidd 1 s alá.
- Minden mérési érték **×10 fixpontos egész** (21,5 °C → `215`), kivéve ahol jelezzük.
- A JSON-válaszok **jogosultság-szűrtek**: amihez a bejelentkezett felhasználónak nincs joga,
  az a kulcs **meg sem jelenik**. Kliens sose számítson fix kulcskészletre.

## 2. Hitelesítés

### 2.1 HTTP Basic (port 80)

Minden HTTP-végpont Basic auth-ot kér (kivétel: `/shellyhook`, ld. 8. fejezet):

```
Authorization: Basic base64(felhasznalo:jelszo)
```

Hibás/nincs azonosító → `401` + `WWW-Authenticate: Basic realm="Secure Area"`.

**Bejelentkezés-fék [3.12.28 / 4.16.1+]** (a 80-as porton és az app-socketen közösen, **IP-címenként**):
egy IP-ről 5 *különböző* rossz jelszó büntetlen, a 6. különböző után az IP 15 s-ra zárolódik, minden
további különböző rossz jelszó a zárat duplázza (30 s, 1 perc … max. 15 perc). Zár alatt a szerver
a jelszót **nem ellenőrzi** (a helyeset sem), a válasz `429 Too Many Requests` + `Retry-After: <s>`
(nincs `WWW-Authenticate`, a böngésző nem dob jelszóablakot). **Ugyanaz** a rossz jelszó ismételve
(böngészőben mentett régi jelszó, jelszócsere után pollozó kliens) nem számít és nem zárol — a
kliens tehát a saját rossz jelszavával sosem zárja ki magát, de a 401-et kezelnie kell. Más IP-ről
érkező kliensekre a zár nincs hatással. A sikeres belépés nem nulláz; a számláló zár nélkül 30
perc, zár után 24 óra csend után felejt. Kliens-ajánlás: 429-nél a `Retry-After` letelte előtt ne
próbálkozz újra, és ne küldj váltakozó jelszavakat. Port-továbbítás + NAT-hairpin (masquerade)
mögött minden WAN-kliens a router IP-jeként látszik — ott a zár az összes távoli klienst együtt érinti.

**CORS (böngészős kliensek más originről — pl. a myIO app PWA-kiadása):**
a szerver minden JSON-válaszra, a statikus `.json`/`.jsn` fájlokra, a 401-re és
a fájlkezelő PUT/letöltés-válaszaira `Access-Control-Allow-Origin: *` fejlécet ad,
az `OPTIONS` kérésre (preflight) pedig hitelesítés nélkül `204`-et válaszol
`Allow-Methods: GET, POST, PUT, OPTIONS` + `Allow-Headers: Authorization,
Content-Type` fejlécekkel. A hozzáférést továbbra is a Basic auth védi — a CORS
csak az origin-korlátot oldja, jelszó nélkül ugyanúgy 401 jár.

Jogosultsági szintek: `0` = admin, `1` = szerkesztő (editor), `2` = felhasználó (user).
A user-szint csak állapotot olvashat és a számára engedélyezett elemeket kapcsolhatja;
a konfigurációs parancsok editor/admin szintet kérnek.

Elemenkénti jog: Read/Write bitek (kapcsolóknál Hit/Press). Jog nélküli elem a JSON-ból kimarad,
a rá adott parancs csendben elutasítódik.

### 2.2 App-socket (port 843)

1. TCP-kapcsolat nyitása után **első sorként** a `base64(felhasznalo:jelszo)` stringet kell küldeni.
   (Egyetlen `.` első sorként = ping, a szerver bont.)
2. Ezután soronként parancsok küldhetők (ld. 9. fejezet).
3. A kapcsolat végét a szerver `.` (normál) vagy `!` (riasztás aktív) sorral jelzi.
4. **[3.12.28 / 4.16.1+]** A bejelentkezés-fék (ld. 2.1) itt is él, közös IP-nkénti számlálóval: zár alatt az
   első sort a szerver nem ellenőrzi, a kapcsolat parancsválasz nélkül `.`-tal zárul (mint rossz jelszónál).

## 3. Elem-azonosítók (ID-térkép)

Az ID-k minden csatornán (parancs, JSON, időzítő, gomb-esemény) azonosak:

| ID | Elem |
|---|---|
| 1–64 | Relé (1-alapú) |
| 101–116 | FET/PWM csatorna (régi hardver, `#ifdef FETPWM`) |
| 201–216 | FET-fade változat |
| 501–520 | Csoport (a csoport-parancsok az 500 alatti értéket automatikusan +500-zal értik) |
| 1000–1899 | Slot-betöltés esemény (jelenet; 1000+slot = minden, 1100+ kategóriánként) |
| 2001–3024 | PCA (dimmer) csatorna ki/be vagy érték (2001 = 1. csatorna) |
| 4001–5024 | PCA-fade változat (fokozatos fel/le futtatás) |

A tényleges darabszámok eszközfüggők, az `info.json`-ból olvashatók ki:
`RQ` (relé), `SQ` (kapcsoló), `PCAQ` (PCA-csatorna), `SHQ` (Shelly), `SENQ` (univerzális szenzor).
**PCAQ akár 160 is lehet** — a 2001+PCAQ feletti ID-ket ne címezd.

Szenzor-azonosítók (a `sensor.json`-ban és aktivátorként):

| ID | Szenzor |
|---|---|
| 1–100 | 1-Wire hőmérő (EEPROM-azonosító) |
| 101–110 | Páraszenzor |
| 200 | Impulzusos fogyasztásmérő |
| 201–203 / 204–206 / 207–209 | SDM teljesítmény / feszültség / áram fázisonként |
| 255 | Nap (napkelte/napnyugta aktivátor) |
| 300 + n | Univerzális szenzor *n* aktivátor-hivatkozása (maga a szenzor: 0–100, a 0-s a soros harmatpont). **[4.x]** relé + PCA-keverő; **[4.4]** FET-keverő + ki/be módú PCA is. A web-UI szenzor-listái 4.3-tól kínálják fel (uSensor optgroup). |

## 4. Vezérlő parancsok — `GET /command:<parancs>`

Az állapot-változtató parancsok URL-be írva mennek:

```
GET /command:r_ON=5            → 5. relé BE
GET /command:PCA*2001=128      → 1. PCA-csatorna 128-ra (0–255)
GET /command:g_INV=1           → 1. csoport váltása
```

Nyelvtan:

- `nev=ertek` — egyszerű beállítás/kapcsolás.
- `nev*index=ertek[,ertek2,...]` — indexelt („csillagos”) parancs, több paraméterrel.
- Több parancs `&`-tel fűzhető össze.
- A válasz egy rövid HTML nyugtázó oldal (nem JSON). Az eredményt a következő
  állapot-lekérdezésből olvasd vissza.
- Ugyanezek a parancsok POST-tal is mehetnek (`POST /info.json`, body: `nev=ertek`,
  `Content-Type: application/x-www-form-urlencoded`) — a web UI így küldi őket.
- **[3.12.30+ / 4.17.1+]** Érvénytelen (negatív, túl nagy vagy rossz tartományú) indexű/azonosítójú
  parancs **no-op**: nem ír, nem kapcsol (pl. `fet*4018=…`, `PCA*4018=…`, `r_ON=300`, `PCAMIN*0=…`),
  hibát sem ad, és a `&`-tel fűzött többi parancs ugyanúgy lefut. A fade-azonosítót (201+, 4001+)
  a közvetlen elemparancsok nem fogadják: a bázis-ID-t küldd (pl. `PCA*2018=…`, `PCA_ON=2018`).

### 4.1 Elemvezérlés (user-szinttől, elem-jog ellenőrzéssel)

| Parancs | Hatás |
|---|---|
| `r_ON=<id>` / `r_OFF=<id>` / `r_INV=<id>` | Relé be / ki / váltás (id: 1–64) |
| `PCA_ON=<id>` / `PCA_OFF=<id>` / `PCA_INV=<id>` | PCA-csatorna be (MAX-szint) / ki (MIN-szint) / váltás (id: 2001+ vagy 1-alapú) |
| `PCA*<id>=<0..255>` | PCA-csatorna konkrét értékre. Ha a csatornán be van állítva időzítő (`PCA_timer`), a MIN fölé állítás **elindítja/újraindítja** azt (a beállított érték megmarad, lejáratkor MIN-re kapcsol); MIN-re állítás leállítja az időzítőt és a késleltetést |
| `f_ON=<id>` / `f_OFF=<id>` / `f_INV=<id>`, `fet*<id>=<v>` | FET/PWM (csak régi hardveren) |
| `g_ON=<id>` / `g_OFF=<id>` / `g_INV=<id>` | Csoport be / ki / okos-váltás (id: 1–20 vagy 501+) |
| `s_hit=<id>` / `s_press=<id>` / `s_release=<id>` | Gomb-esemény szimulálása (rövid/hosszú/elengedés) |
| `usens*<id>=<érték×10>` | **[4.x]** Univerzális szenzor értékének beküldése (pl. `usens*3=215` = 21,5) |
| `thsens*<eepromID>=<érték>` / `humsens*<id>=<érték>` | Hő-/páraszenzor-érték injektálás |
| `dps*1=<érték>` | **[3.12.3+ / 4.x]** Soros harmatpont-szenzor értéke (4.x: 0-s usensor; DUE: a `dps_eid` szerinti hőszenzor-ID-be, ×10) |
| `LogOut=1` | Kijelentkezés |

### 4.2 Konfiguráció (editor/admin szint) — válogatás

Elnevezések: `r_descr*<id>=<szöveg>`, továbbá `p_descr` (PCA), `g_descr` (csoport),
`s_descr` (bemenet), `t_descr` (hőmérő), `h_descr` (pára), `u_descr` (usensor),
`sh_descr` (Shelly), `slo_descr` (slot).

Relé/PCA paraméterek: `r_timer*<id>=<s>`, `r_delay*<id>=<s>`, `PCA_timer`, `PCA_delay`,
`PCAMIN*<id>=<0..255>`, `PCAMAX`, `PCAFadeSpeed`, `min_temp_ON*<id>=<×10>`,
`max_temp_OFF*<id>=<×10>`, `thermoActivator*<id>=<szenzorID>`, `PCA_thermoActivator`,
`PCA_temp_MIN`, `PCA_temp_MAX`.

Kapcsolók (billenő logika — a parancs a flag-et *invertálja*, értéke az elem indexe):
`relaysInvert=<id>`, `relaysAlarm=<id>`, `relaysJustOn=<id>`, `PCAInvert`, `PCAAlarm`,
`PCAJustOn`, `PCA_PWM`, `PCAMixer`, `pullUpGroup=<gid>`, `switchEnabled=<id>`,
`switchNC=<id>`, `hitBlockEnabled=<id>`, `protectionPriority=<index>`.

Struktúrák: `relayProtection*<index>=<elemA>,<elemB>`, `relayJoiner*<index>=<elemA>,<elemB>`,
`relay_group*<gid>=<taghely>,<elemID>`.

Globálisok: `MYIOname=<név>`, `tz=<óra>`, `latitude=<fok>`, `longitude=<fok>`,
`hitTimeLimit=<ms>`, `pressTimeLimit=<ms>`, `protCooldown=<s>` **[4.x]**, `tempTimer`,
`humTimer`, `mixerTimer`, `impulsePerUnit`, `consumptionUnit=<szöveg>`, `T_Sync=1`
(NTP-szinkron most).

Automatikus nyári időszámítás (EU) **[3.12.35 / 4.18.9+]**: `dst_auto=<0|1>` — **érték-szemantika**
(nem billenő, ismételve is ugyanazt állítja), azonnal EEPROM-ba (47) íródik, mentés nem kell.
Alapból **1** (a gyári/szűz EEPROM is BE-t jelent). Bekapcsolva a `tz` a **téli (normál)** eltolás,
a vezérlő március utolsó vasárnap 01:00 UTC-től október utolsó vasárnap 01:00 UTC-ig +1 órát ad hozzá;
az átállás percen belül, magától történik (óra + napkelte/napnyugta + következő időzítő; naplósor
`System,DST,<0|1>,tz=<hatályos eltolás>`). A `/setup` lap változói: `dst_auto` (a pipa) és `dst_now`
(1 = most nyári idő; a hatályos eltolás `timeZone + dst_now`). Ugyanettől a verziótól a `tz=<óra>`
(−24..24) **azonnal** átállítja az órát az eltolás-különbséggel (eddig csak a következő NTP-szinkronnál),
a kézi `year`/`month`/`day`/`hour`/`minute` pedig helyes helyi időnek számít. Régebbi firmware-en a
`dst_auto` hatástalan, a `tz` a teljes (nyáron kézzel átírt) eltolás.

myIO DewPoint **[3.12.3+ DUE]** (a Setup oldalon; a 4.x-en ugyanez `dpo_pca*1`/`dpo_per*1`
a Sensors oldalon): `dps_en=<0|1>`, `dps_eid=<0..99>` (cél hőszenzor EEPROM-ID, 0 = nincs
tárolás), `dps_pca=<0|2001..>` (csak PWM-jelölt PCA), `dps_per=<1..300>` (mp).

Időzítők: `t_id=<slot>` kiválasztás után `t_month`, `t_day`, `t_hour`, `t_minute`,
`t_days=<hétnap-bitmaszk, Hé=64..Va=1>`, `t_sunrise=<0|1|2>`, `t_sunset=<0|1|2>`, `t_event=<típus>`,
végül `t_eventParam=<cél-ID>` (ez commitol). `new_timerSlot=1`, `del_timerSlot=<slot>`.
A nap-mezők **[4.3.8+]** három állapotúak: `0` = nincs, `1` = a napkelte/napnyugta **után**,
`2` = **előtte**; az eltolás nagyságát ilyenkor a `t_hour` (0–23) és `t_minute` (0–59) adja
(`80` = „–”, `90` = „all” → 0 perc). Az eltolás felső határa **240 perc (4:00)** – a vezérlő
ennél nagyobb értéket a tárolás előtt és a kiértékelésnél is levág. A `1` + `t_hour=80` a
korábbi „pontosan napkeltekor” viselkedés, ezért a régi `timer.csv` konverzió nélkül érvényes
marad. Az eredő időpont a nap határán körbefordul (mod 24 óra).

Smart Grid / SG-Ready **[3.12.9 / 4.4.2]** (a `/sg` oldal): `sg_en=1` (billenő),
`sg_k1=<id>`, `sg_k2=<id>` — az egységes ID-térben: relé `1..64` VAGY PCA-kimenet
`2001..2001+PCAQ-1`; `0` = leválasztás (K1 ≠ K2; Védelem/Csatoló-párban szereplő
kimenet kerülendő — a fw a K1==K2-t és az érvénytelen ID-t elutasítja),
`sg_lim=<1..120>` (EVU-zár időkorlát percben, alap 120), `sg_mode=<1..4>`
(azonnali kézi módváltás: 1 = tiltás/EVU-zár [K1=BE,K2=KI], 2 = normál [KI,KI],
3 = ajánlott bekapcsolás [KI,BE], 4 = kényszerített futás [BE,BE]). PCA-kimenetnél
BE = PCAMAX, KI = PCAMIN. Minden mező azonnal perzisztál (EEPROM 36–42: en,
K1 lo/hi, K2 lo/hi, limit, mód). Időzítő-integráció: `t_event=18` +
`t_eventParam=<1..4>` — az időzítő a megadott üzemmódra vált. A vezérlő a
kontakt-párt percenként visszaírja (reteszelés); a tiltás (1) a `sg_lim`
lejártakor magától normálra (2) vált (M60 navbar-üzenet). Újraindítás után az
1-es mód nem áll vissza (normálra vált), a 2/3/4 megmarad.

MIA – myIO Intelligens Asszisztens, öntanuló réteg **[4.11+]** (a `/ai` oldal): `ai_en=1` (billenő mester-kapcsoló),
`ai_feat=<maszk>` (1 = zóna-hőmodell, 2 = ablaknyitás-érzékelés; **[4.12+]** 4 = öntanuló
előfűtés, 32 = fűtés-szünet nyitott ablaknál — beavatkozók, alapból KI; a 8/16 bit fenntartott,
a fw maszkolja), `ai_wd=<10..500>` (ablak: esés °C×100, alap 50), `ai_wm=<2..15>` (perc, alap 5),
`ai_wh=<5..240>` (perc, alap 30), `ai_reset=<relé-ID|0>` (tanult értékek törlése, 0 = mind);
**[4.12+]** `ai_pm=<15..240>` (előfűtés: legfeljebb ennyi perccel a váltás előtt, alap 120),
`ai_pd=<1..6>` (zónánként napi max. indítás, alap 3), `ai_xa=<relé-ID>` (billenő: a zónában MIA
nem avatkozhat be). Minden mező azonnal perzisztál (`ai.jsn`). Beavatkozó bit / MIA / zóna KI →
a tartás azonnal old, a relé visszakerül a termosztáthoz (ld. 10/H).
**[4.13+]** `ai_xt=<relé-ID>` (billenő: a zóna kizárása a túllövés-mentes szabályozásból),
`ai_mo*<relé>=<0..120>` / `ai_mf*<relé>=<0..120>` (zónánként min. BE / KI idő percben, csak MIA
előre-kapcsolásaira; 0 = automatikus: 10, padló-jellegű zónán 30). A TPI-bit (8) az `ai_feat` maszkban.

Riasztóközpont / SIA DC-09 vevő **[4.5.8+]** (a `/alarm` oldal): `al_en=1` (billenő),
`al_port=<1024..49151>` (80/843 tiltott), `al_tcp=1` / `al_udp=1` (billenők; az UDP
azonnal, a TCP csak újraindítás után), `al_acct=<fiók>` (üres = bármely), `al_sup=<perc>`
(felügyelet, 0 = ki), `al_ats=1` (billenő: ACK időbélyeg), `al_s<p>=<usens-id>`
(partíció p=1..ALARM_PARTQ → univerzális szenzor, 0 = leválasztás; auto-enable +
failsafe KI), `al_sim=<DC-03 adat>` (pl. `Nri1/BA01` – szimulált esemény ugyanazon a
dekóderen), `al_reset=1` (számlálók + partíció-memória), `AlarmSave=1` (alarm.jsn +
usensor.jsn). Részletek: 10/F.

Program-motor **[4.10+]** (a `/prog` oldal): `prog_reload=<N|0>` (a `prog/N.txt` újratöltése +
újrafordítása a loop-kontextusban, egy program/kör; `0` = mind), `prog_run=<N>` (kézi egyszeri
futtatás a következő körben — tiltott programon is, ha a fordítása jó), `progen*<N>*<0|1>`
(RAM-szintű engedélyezés/tiltás; a fájl `#enabled` sora az igazság — azt az UI a `PUT /prog/N.txt`-vel
írja át, majd `prog_reload`). Részletek: 10/G.

Slotok: `sav_all=<slot>` (vagy `sav_r/sav_p/sav_gr/sav_pr/sav_sw/sav_gl/sav_f/sav_eman`,
továbbá `sav_net`/`lo_net` **[4.x]**), `lo_all=<slot>` (ill. `lo_*`), `new_slot=1`,
`del_slot=<n>`, `bootUpSlot=<n>`.

Felhasználók: `new_userSlot=1`, `del_userSlot=<n>`, `userName*<slot>=<név>`,
`pwd*<slot>=<base64(user:pass)>`, `rights*<slot>=admin|editor|user`,
`permissionsUser=<slot>` után `rReadPermission=<id>`, `rWritePermission=<id>`,
`pRead/pWritePermission`, `swHit/swPressPermission`, `fRead/fWritePermission`,
`clearPermission=1`, `fillPermission=1`.

Hálózat **[4.x]**: `n_host=<név>`, `n_eth_pri=<0|1>`, `n_wifi_mode=<0|1|2>` (ki/STA/AP),
`n_sta_ssid`, `n_sta_pw`, `n_ap_ssid`, `n_ap_pw`, `n_ap_ch`, majd `NetApply=1`
(azonnali alkalmazás) és/vagy `NetSave=1` (mentés). A socket-kímélő kapcsolók
(`n_svc_app`, `n_svc_mdns`) szintén **[4.x]**.

A Due-n **[3.12.6+]** ugyanez a két socket-kímélő kapcsoló `AppServer=1` /
`Mdns=1` néven megy (billenő logika, admin szint — a Beállítások oldal Haladó
szekciójának pipái küldik). Perzisztencia: EEPROM 87/88; kiolvasatlan (255)
állapotban automatikus alapérték — W5500-on BE, régi W5100/W5200-as (DUEDIN 3.2
előtti) vezérlőn KI, mert a 4 hardveres socketen könnyen leakasztják a chipet.
Bekapcsolás azonnal érvényes; az app-szerver KIkapcsolása után a listener-socket
újraindításkor szabadul fel.

Socket manager **[4.x]**: `n_sm_<szolg>=<maszk>` – szolgáltatásonkénti
interfész-maszk, ÉRTÉK-szemantikával (bit0=LAN, bit1=WiFi-STA, bit2=WiFi-AP;
bejövőnél a két WiFi-bit együtt jár, kimenőnél az AP-bit tiltott). Szolgáltatások:
`n_sm_app` (app843), `n_sm_mdns`, `n_sm_bcast` (broadcast+NTP), `n_sm_blink`
(BroadLink), `n_sm_mqtt`, `n_sm_out` (Shelly + myIO Link: a KÖZÖS kimenő
socketen osztoznak, ezért egy maszk), `n_sm_cloud` (a cloud-kliens **és** a
broker.new auto-fetch — mindkettő a cloud saját socketjén megy).
A firmware minden állítás után sanitizál (HTTP nem maszkolható; WiFi-n a HTTP
mellett max. 1 bejövő szolgáltatás). Perzisztencia a `net.jsn` `sm_*` kulcsaiban,
azonos sorrendben; érvénybe lépés `NetApply=1`-gyel futásidőben vagy restart után.

Rendszer (admin): `Restart=1`, `SensorBackup=1`, `SensorRestore=1`; **[4.x]**:
`OtaCheck=1`, `RestorePrevious=1`, `RdpLock=1` (végleges!), `LogDrain=1`; **[4.5.9]** `LogRet=1`
(QSPI log-retenció kényszerített menete: kártya nélküli módban a 30 legrégebbi napi log törlése, a válasz `message`-ben).

Shelly (`sh_*`), myIO Link (`ml_*`), univerzális szenzor (`u_*`, `dpo_*`) parancsok
**[4.x]**: ld. 8., 10. fejezet és a `usensor.json` leírását.

## 5. Állapot-lekérdezés — JSON végpontok (`GET /<nev>.json`)

Mindegyik `Content-Type: application/json`-nal válaszol. A `d_` előtag (vagy `?desc=1`)
a `description` (név) mezőket is beleteszi — nevekre elég egyszer, induláskor lekérdezni.

| Végpont | Tartalom |
|---|---|
| `sens_out.json` | **Ajánlott poll-végpont**: minden kimenet + szenzor, minimál mezőkkel |
| `f_sens_out.json` | Ugyanaz teljes mezőkészlettel |
| `d_sens_out.json` | + nevek (induló lekérdezéshez) |
| `sens_IO.json` / `f_` / `d_` | **[4.3.12+/3.12.7+]** = sens_out + `inputs` (bemenet-állapotok) |
| `output.json` / `d_output.json` | Relék + PCA + PWM + csoport + védelem + csatoló |
| `relay.json` / `d_relay.json` | Csak relék |
| `pca.json` / `d_pca.json` | Csak PCA-csatornák |
| `groups.json`, `prot.json`, `joiner.json` | Csoportok / védelem-párok / csatoló-párok |
| `sensor.json` / `d_sensor.json` | Hőmérők, páraszenzorok, fogyasztás, SDM |
| `info.json` | Eszköz-azonosítás (ld. 5.2) |
| `usensor.json` | **[4.x]** Univerzális szenzorok + DewPoint-kimenet (nem user-szint) |
| `shelly.json`, `shellyscan.json` | **[4.x]** Shelly-nyilvántartás / -keresés (nem user-szint) |
| `link.json`, `linkscan.json` | **[4.2+]** myIO Link nyilvántartás / keresés (nem user-szint) |
| `sysdiag.json` | Rendszer-diagnosztika pillanatkép (3.12-től; Due-n szűkített kulcskészlet; nem user-szint; ld. 5.3) |
| `prog.json` | **[4.10+]** Program-motor: programok állapota + élő lokális változók + Flow-globálisok + trace (`?since=<tseq>`; editor-jog; ld. 10/G) |
| `ai.json` | **[4.11+]** MIA öntanuló réteg: konfig + zónánként tanult értékek (editor-jog; ld. 10/H) |

### 5.1 Mezőjelentések

**relays** — kulcs: 0-alapú index, értéke objektum:

```json
{"relays":{"0":{"id":1,"description":"Nappali lámpa","state":1,
  "inverse":0,"alarm":0,"justOn":0,
  "timer":120,"timerActive":1,"timerRemain":47,
  "delay":0,"delayActive":0,"delayRemain":0,
  "sensor":3,"sensorON":210,"sensorOFF":220}}}
```

- `id` — elem-ID (1-alapú); `state` — 0/1.
- `timer`/`delay` — beállított másodpercek; `*Active`/`*Remain` — futó visszaszámlálás.
- `sensor` — termosztát-aktivátor ID (0 = nincs; >100 = pára; 300+ = usensor).
- `sensorON`/`sensorOFF` — BE-/KI-küszöb ×10 fixpontban. BE<KI = fűtés-logika, BE>KI = hűtés.
- Minimál (`sens_out.json`) módban csak `id`, `state` (+ ami feltétlenül kell).

**PCA** — mint a relays, plusz: `"id":2001+index`, `"turnOFF"` (MIN-szint), `"turnON"`
(MAX-szint), `"fade"`, `"speed"`, `"mixer"`, `"pwm"` (1 = dimmer-mód). Az aktuális szint
0–255 skálán értendő.

**group** — `"id":501+index`, `"state"` (számított: minden tag be?), `"pullUP"`,
`"elementN"` mezők a tagok elem-ID-jeivel.

**protection / joiner** — `{"0":{"element0":<ID>,"element1":<ID>},...}` párok.

**sensors** — vegyes lista: hőmérők (`id` = EEPROM-ID, `temp` ×10), páraszenzorok
(`id` = 101+, `hum`), impulzus-mérő (`id`:200, `imp`), SDM (`id`:201–206, `act`).

**inputs** **[4.3.12+ / 3.12.7+]** — a fizikai bemenetek (nyomógombok/kapcsolók)
pillanatnyi állapota: `{"0":{"id":1,"state":0},...}`. **CSAK a `sens_IO.json`-család
adja** (`sens_IO.json` / `f_sens_IO.json` / `d_sens_IO.json` = a megfelelő sens_out
+ ez a szekció) — a sűrűn pollozott `sens_out.json` szándékosan változatlan, hogy az
appok forgalmát ne növelje; akit a bemenet is érdekel, a sens_IO-t kérje. `id` =
bemenet-sorszám (1-alapú, mint a setup Bemenetek-fül), `state` = 1, ha a bemenet
éppen zárva/nyomva (az NC-inverzió után értendő logikai állapot). Nem-minimál módban
(`f_`/`d_`) plusz mezők: `enabled` (a bemenet engedélyezett-e), `nc` (alaphelyzetben
zárt kontakt). A `d_sens_IO.json`-ban `description` is (a bemenet neve). A szűrés a
kapcsoló- (`S`) jogosultsággal megy — jog nélküli bemenet ki sem megy. Régebbi
firmware-en a sens_IO végpont nem létezik. Fontos: a 2 mp-es poll a rövid gombnyomást
elkaphatja vagy sem — az `inputs` állapot-megjelenítésre való, esemény-számlálásra nem.

### 5.2 `info.json`

```json
{"info":{"serial":"G400-...","version":"4.3.0","name":"Nappali",
 "RQ":64,"SQ":64,"PCAQ":32,"SHQ":32,"SENQ":100,
 "CPU":"GIGA","fw_date":"...","reset_cause":0,"chipid":"...",
 "bootloader":"prod","rdp":1,"rollback":0,"uptime":12345,"api":3}}
```

Eszköz-felderítésre és képesség-ellenőrzésre való: a kliens innen tudja meg a
darabszámokat (`RQ`, `PCAQ`, …), a verziót és az API-szintet. A myIO-eszközök hálózati
keresése = `GET /info.json` végigpróbálása a /24 tartományon. A `bootloader`, `rdp`,
`rollback` (és az `m4*` diag-) mezők **[4.x]** — a kliens itt se számítson fix kulcskészletre.

**Talált I2C-bővítők [4.3.12+]:** `"pca_online":[0,1]`, `"pcf_online":[]`,
`"inp_online":[[0,1],[]]` — a boot-kori I2C-scan által MEGTALÁLT bővítők indexei.
`pca_online`: PCA9685 chip-indexek a kimeneti buszon — a chip `i` a PCA-csatorna
`16i+1..16i+16` tartományt (elem-ID `2001+16i`-től) hajtja; `pcf_online`: kimeneti
PCF8574-ek; `inp_online`: bemeneti PCF-bővítők multiplexer-csatornánként (belső
tömbönként egy csatorna). Amelyik index hiányzik a listából, azt a bővítőt az eszköz
nem látta a buszon — a kliens ebből jelezhet hiányzó/hibás modult. **Fontos:** a
bemenet-számozás CÍM-alapú (a PCF `k` indexe a `64·mux + 8k + 1 .. +8` bemeneteket
adja), és a bemeneti bővítő báziscíme DIP-kapcsolós — a kiosztás LYUKAS is lehet
(pl. `[[0,1,4,5,6,7]]`: belső bemenetek a 0–1-en, a bővítő a 4–7-en, a 2–3 üres).
Az EXT32 BE (4 PCF) csak FÉL-BUSZRA jumperelhető: bemenet 1–32 (idx 0–3) vagy 33–64
(idx 4–7); az M0 alsó felére tett bővítő a vezérlő beépített 0–1-es PCF-jét
felülírja (a belső 16 bemenet ilyenkor megszűnik). A mezők a 4.3.12+ / 3.12.7+
firmware-ben léteznek.

**QSPI-őr mezők [4.4.3+]:** `"qhealth":1`, `"qheal":0`, `"eepbak":1` — a belső
QSPI-tároló boot-kori írás-visszaolvasás próbájának eredménye. `qhealth`: 1 = a
`/user` kötet írható, 0 = tartós írás-hiba (a beállítások nem menthetők —
szerviz/újraformázás szükséges); `qheal`: 1 = ezen a booton öngyógyító
újraformázás történt (a config az SD-kártyáról állt vissza); `eepbak`: 0 = nincs
`eeprom.bak` a rejtett rendszer-köteten, 1 = van, 2 = az EEPROM-kép ezen a booton
a mentésből állt vissza. (A mentés szándékosan NEM az SD-kártyán él — az
EEPROM-kép hozzáférési adatokat tartalmaz.) A flottakezelő
(`myio_fleet_giga.py status`) e mezők alapján riaszt.

**Jogszint-mező [4.5+ / 3.12.15+]:** `"right":1` — a LEKÉRDEZŐ (bejelentkezett) fiók
jogszintje: 0 = admin, 1 = editor, 2+ = user, 255 = nincs auth-kontextus.
A kliens ebből dönthet, hogy felkínálja-e az editor-jogú parancsokat (pl.
`g_ON`/`g_OFF`) — a mező hiánya (régi fw) esetén a jogszint ismeretlen, a
kliens ne tételezzen fel semmit (a szerver a jog nélküli parancsot úgyis
eldobja).

### 5.3 `sysdiag.json`

Rendszer-diagnosztika pillanatkép a `/sysdiag` weboldalhoz. A 3.12 (Due) firmware-ben a
kulcskészlet szűkebb: `up`, `reset`, `tracelive`, `loops`, `loopmax*`, `ramfree`, `rammin`,
`link`, `reinits`, `reinitc`, `reaped`, `i2c`, `sock` — az alábbi teljes készlet **[4.x]**. **Kérés-vezérelt gyűjtés:**
a firmware nem futtat háttér-mintavételezőt — a grafikonok történetét a kliens építi
(1 lekérdezés = 1 oszlop). Ajánlott poll: 1 Hz. A lekérdezés bejegyzi a hívó IP-jét
(keepalive ~6 s); ha egy ideig senki nem kérdezi, a gyűjtés magától megszűnik. Nem
user-szintű (távoli IP-ket mutat), a `/network`-höz hasonlóan editor/admin jog kell.

```json
{"up":12345,"reset":0,"crashphase":0,"tracelive":21,"grptrace":"00000000","loops":1480,
 "ramfree":312000,"rammin":277000,
 "m4alive":1,"m4btn":1284,"m4to":0,"m4crc":0,"m4gap":0,"m4dup":0,"m4bad":0,
 "link":1,"rssi":0,
 "sock":[[23,80,"192.168.1.31",52880,100], ...8db],
 "outq":[[0,0,0],[0,0,0]],
 "qspit":16384,"qspif":4700,"sdok":1,"sdt":31166976,"sdf":16000000,
 "viewers":1,"pollhz":1,"wanthr":0,"authfail":0,"authlock":0,"authrej":0}
```

- `up` uptime (s), `reset` reset-ok (ld. `info.json` `reset_cause`), `crashphase`/`grptrace`/`tracelive` crash-nyomkövetés, `loops` loop/mp.
- `ramfree`/`rammin` szabad SRAM most / min. watermark (**bájt**).
- `m4*` az M4 társmag gombszkenner-diagja (ld. `info.json` `m4btn`…). [4.5.7] `m4snap`: hányszor jött RÉGI (rövidebb) elrendezésű M4-pillanatkép, amit az M7 előtag-módban fogadott el (>0 = az M4-image lemaradt az M7 mögött, M4-flash javasolt; a gombok ettől még mennek); `m4snapbad`: értelmezhetetlen méretű, eldobott pillanatképek. Naplósor az első eszlelésnél: `System,M4-SNAPSHOT,size=,expected=`.
- `link` W5500 link (1=UP, 2=DOWN, -1=nincs HW), `rssi` WiFi jelerősség (dBm, 0=n/a).
- `wmode` WiFi mód (0=OFF, 1=STA, 2=AP), `wup` STA csatlakozva (0/1), `apup` AP aktív (0/1), `wip` STA IP-cím. **WiFi per-socket kijelzés NINCS**: az mbed LWIP nem tesz ki HW-regisztert/PCB-listát, ezért a WiFinél csak link/RSSI/IP érhető el (a web-UI RSSI-trendgrafikonként mutatja).
- `wsock`/`wsockmax` a WiFi LWIP **socket-mérleg**: lefoglalt / max 4 (a teljes WiFi-stack limitje). `wsvc` a lefoglalt szolgáltatások portjai (pl. `[80]` = HTTP, `[80,843]` = HTTP+app); az AP-DHCPd nem port-alapú, azt a kliens az `apup`-ból teszi hozzá. A szabad hely (max−lefoglalt) marad a bejövő kapcsolatoknak és a kimenőknek. mDNS/UDP a WiFin sosem fut (LAN-only), így nem terheli.
- `sock` a 8 hardveres socket `[SnSR, helyi port, "távoli IP", távoli port, busy%]`. A `busy%` a **mért** kihasználtság: a SockMon 20 Hz-es mintavételéből az utolsó teljes másodperc foglalt-hányada (ugyanaz a mérés, amit a fleet kap; a LISTEN definíció szerint 0%). A mintavétel a `/sysdiag.json` pollra indul, és ~6 s poll-hiány után magától leáll — így a fleet soros `?sockmon.` streamje és a web azonos, közvetlenül összevethető számokat ad.
- `outq` a kimenő HTTP-slotok `[state,kind,ms]` sora (Shelly, Link; **[4.4.1]**-től
  harmadik elemként a webhook `[state,slot,ms]`).
- `qspit`/`qspif`/`sdt`/`sdf` QSPI- és SD-kapacitás (**KiB**), `sdok`=1 ha van kártya (cache-elt, ~5 s).
- `viewers` az aktív (poller) nézetek száma, `pollhz` a mért aggregált lekérdezési ráta — a UI ezekből figyelmeztet, ha több nézet terheli a vezérlőt.
- `authfail` / `authlock` / `authrej` **[3.12.28 / 4.16.1+]** bejelentkezés-fék (ld. 2.1), boot óta: számolt (különböző) rossz jelszavak / indított IP-zárak / zár alatt elutasított kérések. Zárindításkor naplósor: `System,AUTH-LOCK,<ip>,<s>s`.
- `ntp` **[3.12.35, csak Due]** időszinkron-mérés: `[utolsó eredmény, hány mp-e, OK-k, SD-kihagyások, válasz nélküli szinkronok, hatályos eltolás (óra), dst_now]`; az eredmény 0 = még nem volt, 1 = OK, 2 = SD-művelet közben hívódott (2 s múlva magától újra), 4 = két próbára sem jött NTP-válasz (amíg még sosem sikerült: 30 s-ról duplázódó, max 600 s újrapróba; utána 600 s; siker után 1 óra). A 4.x-en ugyanez a soros `?time.` parancsban látszik.
- `loopmaxph` **[3.12.18]** a boot óta leghosszabb kör **leghosszabb lépésének** fázisa (fázis-lépésmérés; korábban a kör utolsó fázisát mutatta, ami BroadLink mellett mindig 20 volt; a 4.x-ben nincs `loopmax*`). `stepmax`/`stepmaxph` **[3.12.18 / 4.5.2]** a boot óta mért leghosszabb egyetlen fázis-lépés (ms) és fázisa. Az eseménynapló `LOOP-STALL` sora is ezt a fázist írja, `step=<ms>` mezővel; a 3 s-nál hosszabb, vagy eldobott chunk miatt bontott HTTP-kiszolgálásról `HTTP-SLOW,<ip>,<ms>ms,<bájt>B,drop=<n>,<url>` sor készül **[3.12.19 / 4.5.2]** (`drop`>0: a válasz csonkán lett lezárva, a kliens újrapróbál).

### 5.4 `/metrics` — Prometheus-scrape **[4.4.1]**

Prometheus-stílusú szöveges pillanatkép (`text/plain; version=0.0.4`) a sysdiag-
adatokból — hosszú távú history-hoz (Grafana) az eszköz semmit nem tárol és semmit
nem kezdeményez: a Prometheus-szerver kérdez le (`scrape_interval: 30s` ajánlott),
auth a szokásos web-userrel (basic auth; nem user-szintű jog kell).

Metrikák: `myio_build_info{version}`, `myio_uptime_seconds`, `myio_loops_per_second`,
`myio_reset_cause`, `myio_crash_phase`, `myio_ram_free_bytes`, `myio_ram_min_bytes`,
`myio_m4_alive` + `myio_m4_*_total`, `myio_eth_link`, `myio_wifi_rssi_dbm`,
`myio_wifi_sockets_reserved`, `myio_socket_state{sock}`, `myio_socket_busy_ratio{sock}`
(a SockMon mért %-a; ritka scrape-nél az utolsó élő mintaablak — trendre való),
`myio_outq_state{cli="shelly|link|webhook"}`, `myio_webhook_sent_total`/`_fail_total`,
`myio_storage_kibibytes{vol,kind}` (cache-elt; első betöltés után jelenik meg),
`myio_usens{ch}` (×10→tizedes; csak élő csatorna), `myio_thermo_celsius{id}` (1Wire).

`# HELP/# TYPE` sorok szándékosan nincsenek (flash-takarékosság) — a scrape enélkül
is működik. Scrape-config minta:

```yaml
scrape_configs:
  - job_name: myio
    metrics_path: /metrics
    scrape_interval: 30s
    basic_auth: { username: user, password: pass }
    static_configs: [ { targets: ['192.168.1.50'] } ]
```

## 6. Fájlok, naplók, OTA

Minden ebben a fejezetben: **editor/admin** szint — KIVÉVE a `users/` fát (lásd 6.1).

- `GET /<útvonal>` — statikus fájl a belső flash-ről (SD-kártya tartalék); a Due-n
  közvetlenül az SD-kártyáról. MIME kiterjesztésből: `.js .json .jsn .css .csv .htm .html .ico .xml`.
- `GET /<útvonal>?v=<webRev>` **[3.12.5+ / 4.3.10+]** — ugyanaz a fájl, **cache-bélyeggel**. A
  `?v=` jelenlétében a válasz `Cache-Control: max-age=31536000, immutable`, enélkül
  `Cache-Control: no-cache`. A bélyeg értéke a lap fejlécében kiadott `var webRev`
  (a `/js` és `/htm` tartalmából — fájlnév + méret + időbélyeg — számolt 32 bites
  hash). A web-UI betöltő-lánca ezzel bélyegzi a saját URL-jeit: amíg a web-fájlok
  nem változnak, a böngésző a cache-éből dolgozik; bármely fájl változásakor a
  bélyeg és így az URL is más lesz, tehát garantáltan újratölt. A bélyeg minden
  fájlkezelő-írás után újraszámolódik. **A query-t a fájlnév-keresés levágja**, tehát
  tetszőleges elérési út bélyegezhető.
- `GET /~q/<útvonal>` **[4.x]** / `GET /~sd/<útvonal>` — explicit belső flash / SD-kártya
  (a Due-n csak SD van, `~q` nincs). **Figyelem:** a `~q/` út a `?query`-t NEM vágja le
  (a fájlnév részének venné → 404) — ide cache-buster helyett `Cache-Control: no-store` kell.
- A statikus és a PUT-útvonalat a firmware **nem URL-dekódolja** → fájl- és mappanév csak
  ASCII-biztos karakterekből álljon (`A–Z a–z 0–9 . _ -`).
- `PUT /<útvonal>` (vagy `/~q/`, `/~sd/`) — fájl-feltöltés, `Content-Length` kötelező.
  Válasz: `200 … OK <byteszám>` vagy `500 … ERR rx=<fogadott bájt>` (betelt tároló, nem
  létező mappa). Az írás **nem atomikus** (előbb töröl, aztán ír), és a PUT **nem hoz létre
  mappát** — előbb `fm_mkdir` szintenként.
- Fájlkezelő műveletek (a paraméterek URL-kódolhatók, a firmware dekódolja; `vol=q` belső
  flash **[4.x]**, `vol=s` SD-kártya):
  - `GET /fm.json?vol=&dir=/út` → `{"path":"/út","total":KiB,"free":KiB,"entries":[{"n":"név",
    "s":bájt,"d":0|1,"t":"ÉÉÉÉ-HH-NN óó:pp"}, …],"ok":1}` (a Due nem ad `total`/`free`-t; a `t`
    hiányozhat). Hibák: `{"ok":0,"err":"nocard"}` (nincs SD), `{"ok":0,"err":"denied"}` (jog),
    `{"ok":0}` (nem mappa / nem létezik).
  - `GET /fm_del?vol=&f=/út` — fájl vagy ÜRES mappa törlése → `{"ok":1|0}`; QSPI-n a `slot_0`, a
    boot-slot és egy gomb/időzítő által hivatkozott slot védett: `{"ok":0,"err":"slotprotected"}`,
    ill. `{"ok":0,"err":"slotref","src":"<hivatkozó>"}`.
  - `GET /fm_mkdir?vol=&d=/út` → `{"ok":1|0}`; `GET /fm_ren?vol=&from=/a&to=/b` (kötetén belül) →
    `{"ok":1|0}`; `GET /fm_cp?src=q:/a&dst=s:/b` (fájl vagy teljes fa, kötetek között is
    **[4.x]**; önmagába másolás tiltva) → `{"ok":1|0,"files":n,"bytes":n}` (a Due csak `{"ok":…}`-t ad).
  - **Due (3.12+):** ugyanezek a végpontok megvannak (`_FileMan.ino`), de csak az SD-kötettel és
    `vol` paraméter nélkül (`fm.json?dir=`, `fm_del?f=`, `fm_ren?from=&to=`, `fm_mkdir?d=` —
    szülőkkel együtt —, `fm_cp?src=s:/a&dst=s:/b` csak fájlra), plusz `GET`/`PUT /~sd/<út>`.
    User-szintű (2-es) fióknak a Due-n egyik sem érhető el.
- `GET /fm_sync[?op=sd|sdweb|adopt]` **[4.4.3]** (admin/manager) — QSPI→SD tükör
  indítása (`sd` = konfig, `sdweb` = konfig + htm/js webfák, `adopt` = idegen
  kártya örökbefogadása: mirror.tag írása) és állapot-lekérdezés (op nélkül csak
  státusz). Válasz: `{"run":0|1,"phase":n,"web":0|1,"copied":n,"deleted":n,
  "bytes":n,"card":0|1,"tagged":0|1,"cur":"útvonal"}`. A tükör csak egészséges
  (`qhealth=1`) és provisionalt QSPI-ról fut; tag nélküli, configot hordozó
  kártyához védelemből nem nyúl.
- `GET /forcefm` — mindig a firmware-be égetett (flash-beli) recovery-fájlkezelőt
  adja, a tárolón lévő `js/fm.js` meglététől függetlenül (üres/sérült
  tárolónál is használható a web-UI feltöltésére). **[4.x]**: a `GET /fm?rec=1`
  ugyanezt teszi.
- **Naplók**: napi CSV-k — sima fájlként letölthetők. Útvonalak (`ÉÉHHNN` = a vezérlő helyi
  dátuma): `ev_log/e_ÉÉHHNN.csv` eseménynapló, `c_log/c_…` fogyasztás, `sdm_log/s_…` SDM-mérő,
  `t_log_<N>/t_…` 1Wire-hőmérő (N = szenzor-index), `h_log_<N>/h_…` páratartalom,
  `u_log_<N>/u_…` univerzális szenzor **[4.x]**. **[4.x]**: a naplók SD-elsők (kártya nélkül a
  belső flashre kerülnek). Az NTP-szinkron ELŐTTI sorok 1970-es dátummal egy külön fájlba
  kerülnek: `ev_log/e_2260101.csv` **[4.x]** (az évszám kódolása miatt), ill. `ev_log/e_700101.csv`
  (Due). Sorformátum: **[4.x]** `<szint>,ÉÉÉÉ/HH/NN óó:pp:mm,<forrás>,…`, Due-n szint nélkül
  `ÉÉÉÉ/HH/NN óó:pp:mm,<forrás>,…`. **[4.x]**: `ev_log`-ot tartalmazó
  útvonal lekérése előbb kiüríti a RAM-puffert, tehát mindig friss.
  **[4.x]**: az `ev_log/` CSV **első oszlopa a naplószint** (`E`=ERROR, `I`=INFO,
  `D`=DEBUG); a régi (3.x) szint nélküli sorokat a webes nézet is helyesen
  jeleníti meg (az oszlop-felismerés automatikus). Szint szerint `grep`-pel szűrhető.
- **Naplószintek (soros)** **[4.x]**: a soros kimenet szintezett `[ERROR]`/`[INFO]`/`[DEBUG]`
  előtaggal. Kapcsolás soros parancsból (EEPROM-ban megőrizve): `log` (állapot),
  `log err`, `log info`, `log debug` (a `log debug` = a régi `serial debug`).
- **OTA** **[4.x]**: 1) `PUT /MYIO_UPD.BIN` (kombinált csomag), 2) `GET /command:OtaCheck=1` →
  az eszköz újraindul és frissít, hiba esetén automatikusan visszaáll.
  `GET /command:RestorePrevious=1` = kézi visszaállás.
  A Due (3.12) frissítése nem webes: az SD-kártyára másolt BIN-ből, soros
  `!ota check.` paranccsal történik (flash-bank váltással).

### 6.1 `users/` fa — user-jogú fájl-hozzáférés (app-profilok) **[4.x]**

A mobil-/PWA-app a kezelőpult-elrendezéseket a szerver tárhelyére menti:
`users/<login>/dash/<név>.json` (belső flash/QSPI). Hogy ehhez ne kelljen
editor-jog, a **user (2-es) szintű** fiók a fájl-végpontok egy szűkített
részhalmazát is használhatja:

- `PUT /users/<saját login>/...` — írás KIZÁRÓLAG a saját mappa alá
  (a `<login>`-t a firmware a Basic-hash-ből dekódolja és egyezteti);
- `GET /fm.json?vol=q&dir=/users...` — a TELJES `users/` fa listázható
  (családi profil-tallózó: más user mentése is betölthető), máshol `denied`;
- `GET /fm_mkdir?vol=q&d=...` — `/users` gyökér vagy a saját mappa/al-mappái;
- `GET /fm_del?vol=q&f=...` — csak a saját fájában;
- statikus `GET` (fájl-letöltés) minden bejelentkezett szintnek eddig is járt.

SD-kötet (`vol=s`, `~sd/`) és `..`-t tartalmazó útvonal user-joggal tilos.
A PUT-útvonalat a firmware nem URL-dekódolja → a fájlnév csak ASCII-biztos
karakterekből álljon (`A–Z a–z 0–9 . _ -`). Editor/admin szintre a fenti
szűkítés nem vonatkozik. A Due-n (3.12+) a fájlkezelő-végpontok megvannak (ld. 6.),
de CSAK editor/admin joggal — a user-szintű `users/` kivétel ott nincs, ezért a dash-export
user-fiókkal a Due-n nem elérhető (az app verzió szerint kapuzza).

## 7. Soros protokoll (fejlesztéshez/diagnosztikához)

Keretezés: `?parancs.` = olvasás, `!parancs.` = írás/művelet (a `.` zárja a keretet) —
mindkét firmware-ben azonos. Minden 4. fejezetbeli webes parancs sorosan is megy
admin-jogon: `!r_ON=5.`, `!PCA*2001=128.` stb. Hasznos olvasások: `?ip.`, `?time.`,
`?fr.` (szabad RAM); **[4.x]**: `?m4.` (gomb-processzor állapota), `?shelly.`, `?link.`,
`?usensor.`, `?wifiscan.`; **[4.18+]** `?radio.` (WiFi/LAN rádió-állapot: konfigurált és futó
mód, STA/AP, valódi link, IP, RSSI; Optán a rádió-politika belső állapota), **[4.18.5+]** a `?time.`
az utolsó NTP-próba eredményét is kiírja (`ntp=` 1 OK / 2 SD-tranzakció / 3 nem nyílt socket /
4 nincs válasz, `if=LAN|STA`, mp); **[4.18.9+]** utána `tz= dst_auto= dst_now= tzclk=` (az órára
ráállított teljes eltolás), **[3.12.35+ Due]** `ntp= ok/sd/fail= tz= dst=<auto>/<most>`. **Figyelem:** a `?netwifi.` NEM csak olvas — újra alkalmazza
(újrahúzza) a WiFi-beállítást. Műveletek: `!sync time.`, `!ethernet init.`, `!ota check.`,
`!sensor backup.`; **[4.x]**: `!ap on.` / `!ap off.`, `log err/info/debug`; **[4.18+]**
`!svcap on.` / `!svcap off.` (Opta szerviz-AP kábel nélküli bootnál, mentéssel). A `.` keret-zár
miatt pontot tartalmazó érték (pl. `Okoslak.hu` SSID) sorosan NEM küldhető — ilyenkor HTTP.
**[4.10+]** Program-motor: `?prog.` (státusz-dump: pool, programonként állapot/ciklus/futások/
max µs/hibaszöveg + lokális változók), `!progreload*<id|0=mind>.`, `!progrun*<id>.`,
`!progen*<id>*<0|1>.` — ld. 10/G.
(`?` + `.` = parancslista, csak dev-bootloaderen.)

## 8. Shelly-webhook (az egyetlen auth-mentes végpont) **[4.x]**

A Shelly-eszközök hívják vissza a myIO-t; token védi:

```
GET /shellyhook?t=<8 jegyű token>&sw=<bemenet-index>&ev=<H|P|R>   ← gomb-esemény
GET /shellyhook?t=<token>&sen=<usensorID>&val=<érték>             ← szenzorérték (float, ×10-ként tárolódik)
```

Válasz: `200 OK` / `403 DENIED`. Csak olyan `sw`-t fogad el, ami tényleg Shelly-hez van
kötve. A token a `shelly.json`-ban látszik, `sh_token=1`-gyel újragenerálható.

## 9. App-socket parancsok (port 843)

Autentikáció után (2.2) soronként:

- `?R` `?F` `?P` `?S` `?T` `?H` `?C` `?O` — tömör állapotsorok (típusbetű + elemenként
  1 karakter/érték). Relé-kódolás: `1`/`0` (be/ki, írható), `R`/`r` (csak olvasható),
  `w` (csak írható), `X` (nincs jog). FET/PCA: jog-betű + 3 jegyű érték.
- `?RD` `?FD` `?PD` `?SD` `?TD` `?HD` `?D` — nevek (description-ök).
- `?output.json`, `?info.json`, `?sens_out.json` stb. — az 5. fejezet JSON-jai
  **HTTP-fejléc nélkül**.
- Bármely más sor (pl. `PCA*2001=128` vagy `!...`) a teljes parancs-értelmezőre megy
  (= 4. fejezet).

## 10. myIO Link és UDP broadcast

- **Link** **[4.2+]**: a vezérlők egymást a szabványos végpontokon pollozzák (`/sens_out.json`,
  `/info.json`, `/d_sens_out.json`) Basic auth-tal — kliensként te is pontosan így tükrözhetsz.
  Konfigurálás `ml_*` parancsokkal, állapot a `link.json`-ban.
- **Broadcast**: ha engedélyezett, a vezérlő minden parancs-köteg után UDP-csomagot küld
  a `<szubnet>.255:17000` címre: `"<ip>&<reléállapotok>"` (RQ darab `0`/`1` karakter).
  Passzív, azonnali állapot-értesítésre használható; bemenő UDP-parancs **nincs**.

## 10/A. MQTT-publikálás **[4.3+ · DUE 3.12.31+]**

A vezérlő (ha az MQTT oldalon engedélyezve van) MQTT 3.1.1 kliensként csatlakozik a
konfigurált brókerhez (TLS: [4.4]). Két üzemmód: **folyamatos** (állandó kapcsolat +
keepalive + valós LWT; 1 socketet tartósan foglal) és **takarékos**
(connect→publish→clean disconnect az intervallum lejártakor vagy függő eseménynél;
nem foglal állandó socketet, az elérhetőség-jelzés közelítő). Alaphelyzetben
**publish-only**; a bejövő irányt (vezérlés + külső szenzorok) a **[4.5]** subscribe
szakasz adja lentebb — bekapcsolva a takarékos módot felülírja (tartós kapcsolat).
Témák (`<base>` alapértelmezése `myIO/<hosztnév>`):

**DUE (3.12.31+):** azonos topic-séma, Discovery és parancs-út (közös, bitre azonos
`mqtt_ha.cpp` + `mqtt_client.cpp`); `dev.mdl` = `Valet Due`. Nincs: TLS, takarékos mód,
`usens/*` és `mqsen` (külső szenzor), `exp/*`, hosztnevű bróker (a `mq_host` csak IPv4,
különben `host-not-ip` napló + max backoff). A kimenet-állapot (relé/PCA/FET) MINDEN
kapcsolási útról állapot-diffel (shadow) megy ki (nincs LogPush-esemény). Konfig: EEPROM
5964..6219 (nem `mqtt.jsn`; az `EepromFormat` törli); web-paraméterek a 4.x-szel azonosak
(`mq_*` + `MqttSave` + `MqttRediscover`), a hiányzók nem jönnek ki; képesség-változók a
/mqtt oldalon: `mq_redisc`, `mq_iponly`, `mq_nous`, `mq_sockwarn` (W5100-lap + app843/mDNS).
Bekapcsolt MQTT mellett a :80 listen-backlog 3 → 2. Soros: `?mqtt.`.

| Téma | Payload | Mikor |
|---|---|---|
| `<base>/status` | `online` / `offline` | csatlakozáskor / LWT (retained) |
| `<base>/relay/<1..RQ>` | `1` / `0` | változáskor + periodikusan |
| `<base>/pca/<n>` | `1` / `0` | változáskor + periodikusan |
| `<base>/fet/<n>` | `1` / `0` | változáskor + periodikusan |
| `<base>/button/<1..SQ>` | `H` / `P` / `R` | gomb-gesztuskor, kiosztatlan eseménynél is (sosem retained) |
| `<base>/sensact/<id>` | `1` / `0` | szenzor-aktivátor váltásakor |
| `<base>/temp/<eepromID>` | pl. `23.50` | periodikusan |
| `<base>/hum/<1..8>` | pl. `45.3` | periodikusan |
| `<base>/usens/<id>` | pl. `21.5` | periodikusan (típus a discovery-ben) — **[4.x]** |
| `<base>/sdm/<1..3>/power` | watt (egész) | periodikusan |

**Home Assistant Discovery** (kapcsolható): csatlakozáskor retained config-üzenetek a
`homeassistant/<komponens>/<node>/<objektum>/config` témákra; relé/PCA/FET →
`binary_sensor` (csak elnevezett elemek), hőmérő/pára/usens/SDM → `sensor` a típus
szerinti egységgel; **[4.16.2+]** `stat_cla` is: `measurement`, a kWh-usens (`sen_Type` 6)
`total_increasing` (HA hosszú távú statisztika + Energia-dashboard). A `dev.mdl` board-függő
(`Valet GIGA` / `Valet Opta` / `Valet Due`). Az értékek előjelhelyesek (−0,5 °C = `-0.50`; 4.16.2 előtt a −1…0
közötti értékek előjel nélkül mentek ki). Konfiguráció: gyökér `mqtt.jsn` (web: MQTT oldal, `mq_*` paraméterek
+ `MqttSave`); soros diagnosztika: `?mqtt.`.

### MQTT subscribe — vezérlés + külső szenzorok **[4.5 · DUE 3.12.31+, a külső szenzorok csak 4.x]**

A `mq_sub` főkapcsolóval a kliens a CONNACK után feliratkozik (új állapot: `MQ_ST_SUB=7`),
és a kapcsolat tartósan nyitva marad. Clean session — minden reconnect újra-feliratkozik.

**Vezérlés** (`mq_cmd`; wildcard-feliratkozás QoS1-gyel):

| Téma (bejövő) | Payload | Hatás |
|---|---|---|
| `<base>/relay/<1..RQ>/set` | `1`/`ON`, `0`/`OFF`, `T`/`TOGGLE` | relé be/ki/váltás |
| `<base>/pca/<1..PCAQ>/set` | szám `0..255` (0=ki, 1..255=fényerő) vagy `ON`/`OFF`/`T` | PCA vezérlés |

A parancs a `mq_cslot` user-slot jogaival fut (`0` = admin; jog-megtagadás naplózódik).
Végrehajtás a közös parancs-diszpécseren (`r_ON=` / `PCA*<2000+id>=` alakra fordítva),
így a kapcsolás a state-topicon visszajelződik. Cmd-módban új kimenő téma:
`<base>/pca/<n>/bri` = 0..255 (a HA light fényerő-state-je), és a discovery a relét
`switch`-ként (+`cmd_t`), a PCA-t `light`-ként hirdeti (`bri_scl:255`,
`on_cmd_type:brightness`); **[3.12.34 / 4.18.8+]** a `PCA_PWM=0` csatorna (0/255) csak
ki-be `light` (nincs `bri_*` / `on_cmd_type`, ugyanaz a `uniq_id` – a HA helyben frissít),
és a `pca/<n>/bri` csak PWM-csatornára megy ki; mód-váltáskor a régi platform configja üres retained
üzenettel törlődik (tombstone).

**Termosztát / redőny / RGB** **[4.17+]** (cmd-módban; a Homey-app driver-modelljei).
Discovery: `climate` + `number` (hiszterézis), `cover`, `light` (rgb); publish-only módban a
configjuk üres retained (tombstone). Feliratkozás: `<base>/thermo/+/+`, `<base>/cover/+/set`,
`<base>/rgb/+/+` (QoS1; a két szintű utótag miatt a saját állapot-topic nem jön vissza).

| Téma | Irány | Payload |
|---|---|---|
| `<base>/thermo/<r\|p><n>` | ki | `{"cur":21.37\|null,"set":21.5,"hys":1.0,"mode":"heat\|cool","act":"heating\|cooling\|idle"}` |
| `<base>/thermo/<r\|p><n>/set` | be | cél °C (pl. `22.5`) → ON/OFF küszöb = cél ∓ sáv/2 (a sáv marad) |
| `<base>/thermo/<r\|p><n>/hset` | be | hiszterézis °C (0,1..10) → a közép marad |
| `<base>/cover/<p>` | ki | `opening` / `closing` / `stopped` |
| `<base>/cover/<p>/set` | be | `OPEN` / `CLOSE` / `STOP` (az ellenirány előbb ki) |
| `<base>/rgb/<g>` | ki | `{"state":"ON\|OFF","r":..,"g":..,"b":..,"bri":0..255}` (szín max-normálva) |
| `<base>/rgb/<g>/set` · `/cset` · `/bset` | be | `ON`/`OFF` · `r,g,b` · `0..255` |

Termosztát = elnevezett relé (`r<n>`) vagy nem-mixer, nem-PWM PCA (`p<n>`) `thermoActivator`
1..100 (DS18B20) vagy **[4.x]** 301..300+SENQ (usens, típus 1/4) forrással; a parancs a közös
diszpécseren `min_temp_ON*`/`max_temp_OFF*` ill. `PCA_temp_MIN*`/`PCA_temp_MAX*` alakban fut
(mint a Homey). Frissítés újracsatlakozás nélkül: `MqttRediscover=1` (a /mqtt oldal gombja;
discovery + teljes állapot-kép újra), valamint automatikusan 5 s-mal bármely `*_desc.xml`-írás
(átnevezés), `thermoActivator`/`PCA_thermoActivator`/`relayProtection`/`relay_group`/`u_en`/
`u_type`/`PCAMixer`/`PCA_PWM` után. Redőny = `relayProtection[p-1]` ([0] = FEL, [1] = LE). RGB = „RGB”-vel kezdődő
nevű csoport (`<g>` = csoport-sorszám), R/G/B betűvel kezdődő nevű PCA/FET tagjai (fade-id
4001+/201+ is). A szabályzó által **közvetlenül** kapcsolt relé állapota 4.17-től azonnal
kimegy a `relay/<n>` topicon (relé-shadow; korábban csak a periodikus körrel); ugyanígy a
PCA be/ki, a csak értékben változó PCA fényereje (`pca/<n>/bri`, pl. csúszka vagy fade) és a
ráépülő RGB-állapot legfeljebb 250 ms-on belül, a FET be/ki is. **[3.12.34 / 4.18.8+]** Ezek az
élő állapot-üzenetek (parancs-echo, esemény, kimenet-shadow) a (re)discovery ALATT is mennek
(korábban egy nagy ház ~20 s-os újra-discoveryje alatt vártak).

**Külső MQTT-szenzorok** **[4.x]** (kötés-tábla, gyökér `mqsen.jsn`, slotszám: `MQSENQ`
build-define, alap 8, max 32): topic (pontos egyezés, max 64 kar.) + opcionális
top-level JSON-kulcs (max 24 kar.) + cél usens-slot (1..SENQ). Az érték
`SenSetValue()`-val íródik (x10 fixpont; `ON/true`→10, `OFF/false`→0), így az
aktivátor- (300+slot), failsafe- és napló-utak változatlanul működnek. Web-paraméterek:
`mqs_t<slot>=`, `mqs_k<slot>=`, `mqs_i<slot>=` (0 = leválasztás; kötés = a cél-szenzor
auto-enable); a `MqttSave` a `mqtt.jsn` + `mqsen.jsn` + `usensor.jsn` hármast menti és
újracsatlakozik. Konfig-kulcsok a `mqtt.jsn`-ben: `sub`, `cmd`, `cslot`. Diagnosztika:
`?mqtt.` → `sub= cmd= cslot= subph= den= cmdrx= senrx= last=`; RX-plafon 768 bájt/csomag
(a nagyobb csomag drain-nel eldobódik).

## 10/B. Ledszalag (WS2812) **[4.3.4+]**

A D26–D33 lábak DHT-csatlakozói ledszalag-kimenetté konfigurálhatók (LEDSTRIP_PLAN.md).
Lábmód: **EEPROM 99** bitmaszk (bit i = IO(i+1) csatlakozó LED-módban), restart-kötött. A `ledstrip.jsn` `s<i>` kulcsai is IO-indexűek (s0=IO1). Minden más
konfig a gyökér **`ledstrip.jsn`**-ben (mentés: `ls_save`).

**Esemény-ID (bemenet/időzítő/parancs):** `3100 + (IO−1)×100 + program`
(IO=1..8 az alaplapi csatlakozó: IO1=D32, IO2=D33, IO3=D30, IO4=D31, IO5=D28, IO6=D29, IO7=D26, IO8=D27; program=1..32; program=0 = a teljes szalag KI).
Egy ID toggle-ként működik: első hívás BE (fázisgép: bekapcsolás→futás), második KI.
Külön szegmensű programok egymás mellett futnak; átfedő indítás leváltja a régit.

**HTTP-paraméterek** (GET/POST param-út, auth kell; élőben érvényesülnek):

| Kulcs | Jelentés |
|---|---|
| `led_ev=<ID>` | esemény-szimuláció (a Teszt gomb is ezt küldi) |
| `led_p*<prog>=<mező>,<érték>` | program-mező élő állítása (mező-index: 0=fx 1=sp 2=bri 3=int 4=den 5=len 6=pal 7=dir 8=c1 9=c2 10=a 11=b 12=bm 13=bfx 14=bd 15=km 16=kfx 17=kd 18=offp; **[4.5]** 19..22=g0..g3 játék-gomb, 255=nincs) |
| `led_pnm*<prog>=<név>` | program neve (max 15 kar.) |
| `led_n*<pin>=<db>` | LED-szám (restart-kötött) |
| `led_t*<pin>=<típus>` | chip-típus (0=WS2812/GRB; RGBW rezerv) |
| `led_mask=<maszk>` | lábmód-bitmaszk → EEPROM 99 + M58 üzenet (restart!) |
| `led_en=1` | ledszalag-funkció ki/be (toggle, élő) |
| `ls_save=1` | mentés a gyökér ledstrip.jsn-be |
| `led_teach*<prog>=<szerep>` | **[4.5]** gomb-betanítás: a következő fali gombnyomás (10 mp-en belül) a szerephez rendelődik; szerep=0..3, minden más érték = teach-megszakítás |

**`GET /ledfx.json`** – effekt-leírók: `{"ledfx":{"q":18,"fx":[{"k":"fire","o":0,"p":"pal,sp,bri,int"},…,{"k":"pong","o":0,"p":"sp,bri,int,len,c1,c2","g":"l,r"},…]}}`
(`k` = effekt-kulcs, `o` = one-shot, `p` = használt paraméterek; **[4.5]** `g` = játék-szerepek CSV,
csak játék-effektnél). A web-UI ebből generálja a vezérlőket – új effekt/játék webmódosítás
nélkül jelenik meg.

**`GET /ledgame.json`** **[4.5]** – játék-gomb állapot:
`{"ledgame":{"teach":<prog|0>,"role":<szerep>,"gsw":[[g0,g1,g2,g3]×32]}}` (`teach` = épp betanítás
alatt álló program vagy 0; `gsw` = programonként a 4 szerep kapcsoló-indexe, 255=nincs). A /ledstrip
oldal a Tanít gomb alatt 500 ms-onként pollozza. Amíg egy játék-program példánya fut, a betanított
kapcsolók eseményei a játékhoz mennek (a normál hit/press/release akció és a napló-push elnyomva);
leállás/eviction/idle-auto-stop (5 perc) után automatikusan visszaállnak.

**`sens_out.json`** – új `led` blokk (csak ha van aktív szalag):
`"led":{"l_3100":{"state":1,"prog":2,"n":60},…}` (kulcs = a szalag ID-bázisa).

**Soros (bench):** `?led.` = állapot-dump (mód/LED-szám/példányok/frame-idő);
`!led_ev=3101.` = esemény-szimuláció; a fenti `led_*` kulcsok `!kulcs=érték.` formában
is mennek a soros param-úton.

## 10/C. myIO Cloud — aláírt parancs-csatorna **[4.4]**

A vezérlő (ha a /cloud oldalon engedélyezve van) állandó, **mindig-TLS** MQTT-kapcsolatot
tart a myIO Cloud brókerrel (pinnelt EC P-256 bróker-kulcs, BearSSL; plaintext-ág nincs).
A user-brókeres MQTT-kliens **mellett** fut (dual; egyszerre csak Ethernet-egress mellett —
Wi-Fi-n a user-MQTT élvez elsőbbséget). Témák (`<devId>` = gyári sorozatszám sanitálva,
fallback: chip-UID hex):

| Téma | Irány | Tartalom |
|---|---|---|
| `myioc/<devId>/cmd` | app→eszköz (sub, QoS1) | aláírt parancs-keret (lásd lent) |
| `myioc/<devId>/pair` | app→eszköz (sub, QoS1) | párosítás-keret, csak nyitott ablakban |

**Párosító QR (v4, [4.5]).** A rejtjelezett payload (`myioc://c?d=…`) mezői sorban:
`ver(1)=4 | keyId(1) | port(2 BE) | hostLen|host | devidLen|devid | labLen|label |`
`dp(64) | pt(16) | bkLen|bk(0|65) | auLen|appUser | apLen|appPass`.
A két záró mező **[4.5]** újdonság: az app bróker-belépője (per-eszköz `app-<serial>`
fiók). E nélkül az app névtelenül csatlakozna, amit az éles bróker
(`allow_anonymous false`) elutasít. A **parancs-jogot nem ez adja** — azt továbbra is
a párosításkor generált ECDSA-kulcs és a hozzárendelt user-slot dönti el. A v3 payload
(4.5 előtti firmware) továbbra is olvasható, üres belépővel.

| `myioc/<devId>/status` | eszköz→bróker (retained) | `online` / `offline` — LWT, **[4.5]** *és* szándékolt lezáráskor (kikapcsolás, bróker-váltás) kiadott búcsú-üzenet |
| `myioc/<devId>/evt` | eszköz→bróker | események (pl. `pair-ok:<keyId>`) |
| `myioc/<devId>/perm/<keyId>` | eszköz→bróker (retained) | a kulcs slotjának jog-leírója (lásd lent) |
| `myioc/<devId>/stat` | eszköz→bróker (retained) | állapot-publikálás (későbbi kör) |
| `myioc/vendor/msg` | gyártó→flotta (sub, QoS0, **retained**) | **[4.5]** gyártói csatorna — vendor-aláírt boríték (lásd lent) |

**Parancs-keret** (bináris, a `/cmd` payloadja):
`[ver(1)=2][keyId(1)][counter(4 BE)][cmdLen(2 BE)][command(N)][signature(64 = r||s)]` —
ECDSA P-256 aláírás a `SHA-256(ver‖keyId‖counter‖cmdLen‖command)` fölött a user
**telefonján tárolt privát** kulcsával; az eszköz a párosításkor kapott **publikus**
kulccsal ellenőriz. A `command` a nyers parancs-string (pl. `r_ON=5`), és a kulcshoz
kötött **user-slot jogaival** fut (CheckUserPermission változatlanul érvényes). Replay-védelem:
kulcsonként szigorúan monoton `counter` (floor QSPI-n, +64-es előre-ablakkal perzisztálva).

**Párosítás-keret** (a `/pair` payloadja, csak admin-nyitott 5 perces ablakban):
`[ver(1)=2][keyId(1)][upub(64)][mac(32)]`, ahol `mac = HMAC-SHA256(ptok, ver‖keyId‖upub)`
— a `ptok` a QR-ben kapott egyszeri token (felhasználás után törlődik). Siker: `pair-ok:<keyId>`
a `/evt`-n.

**QR/párosító-link.** Két formátum (az app mindkettőt érti):
- **v2 (nyílt, legacy):**
  `myioc://<host>:<port>/<devId>?v=2&k=<keyId>&dp=<eszköz-pubkey b64url>&pt=<ptok b64url>&u=<címke>&bk=<bróker pinnelt kulcs>`
  (a `bk` a terven felüli mező: az app ebből pinnel a TLS-hez).
- **v3 (rejtjelezett) [4.4]:** `myioc://c?d=<b64url( nonce(12) ‖ AES-256-CTR(payload) )>`.
  A firmware állítja elő (a `/cloud` http-oldalon a böngésző WebCrypto-ja nem elérhető).
  A `payload` kompakt bináris: `ver(1)=3│keyId(1)│port(2 BE)│hostLen(1)│host│devidLen(1)│devid│labLen(1)│label│dp(64)│pt(16)│bkLen(1)│bk(0|65)`.
  AES-256-CTR, 12 bájt TRNG-nonce, számláló 0-ról (BE). A `QR_OBF_KEY` be van **égetve a firmware-be és az appba** (`cloud_crypto.cpp` ⇄ `cloud_codec.dart`, bájtra azonos).
  **Figyelem — obfuszkáció, nem titkosság:** a kulcs minden példányban azonos, egy elszánt támadó kiszedi; célja, hogy a QR ne legyen generikus olvasóval „képeslapként" olvasható (host/devId/bk). A valódi hozzáférés-védelem a per-user bróker-ACL (backend-kör), az egyetlen kripto-titok a `ptok` (egyszeri, idő-ablakos). Az integritást a fenti pair-keret HMAC-ja és a parancs-ECDSA adja (ezért CTR auth-tag nélkül is elég).

**JS-változók a `/cloud` lapon — PROD/DEV kapu [4.5].** Gyári (prod) firmware
(`CFG_DEV_BUILD=0`) **nem küldi ki** az üzemeltetési adatokat: `cl_host`/`cl_user`/`cl_pw`/
`cl_tkey` üres, `cl_port=0`, `cl_bip='0.0.0.0'`, `cl_fb=[]`, és `cl_prot=1` jelzi a lapnak,
hogy „rejtve" sorokat rajzoljon szerkeszthető mezők helyett. Dev-buildben `cl_prot=0` és
minden kimegy. Ami prod-ban IS megy: `cl_en`/`cl_state`/`cl_devid`/`cl_devkey`/`cl_dpub`
(publikus kulcs), a kulcstábla és a párosítás-QR (`cl_blob`) — utóbbi szükségszerűen
tartalmazza a host+port+pinnelt kulcsot, mert az appnak abból kell csatlakoznia, ezért ez a
kapu **mélységi védelem, nem kriptográfiai határ**. **[4.6]** A bróker-provisioning
POST-mezők (`cl_host`/`cl_port`/`cl_user`/`cl_pw`/`cl_auser`/`cl_apass`/`cl_tkey`) prod-ban
**be sem fordulnak** — a belépő a gyártói beégetéssel érkezik, a rotáció/költözés útja a
`cl_bnew` (vendor-aláírt blob), ami mentőövként prod-ban is él, ahogy a `cl_en`, a
párosítás-műveletek és a `CloudSave` is.

**HTTP-paraméterek** (GET/POST param-út, editor-jog; élőben érvényesülnek):

| Kulcs | Jelentés |
|---|---|
| `cl_en=1` | Cloud-kliens ki/be (toggle, élő) |
| `cl_host=<cím>` / `cl_port=<n>` | bróker cím/port (alap: 8883) — **[4.6] csak dev-build** |
| `cl_user=` / `cl_pw=` | eszköz bróker-belépője — **[4.6] csak dev-build** |
| `cl_auser=` / `cl_apass=` | **[4.5]** app bróker-belépő (a párosító QR viszi tovább) — **[4.6] csak dev-build** |
| `cl_tkey=<b64url>` | pinnelt bróker-pubkey — **[4.6] csak dev-build** |
| `cl_plab=<név>` | a következő párosítás címkéje |
| `cl_pair=<slot>` | párosítás indítása a user-slotra (0 = admin tilos) |
| `cl_pairstop=1` | párosítási ablak zárása |
| `cl_krev=<idx>` | kulcs visszavonása/újraengedése (tábla-index!) |
| `cl_kdel=<idx>` | kulcs törlése (azonnal perzisztál) |
| `CloudSave=1` | mentés a gyökér cloud.jsn-be + újracsatlakozás |
| `cl_bnew=<b64url>` | **[4.4]** `broker.new` provisioning-blob feltöltése (vendor-aláírt bróker-cím-frissítés; sapka 1024 b64-karakter / 768 bájt raw) |
| `cl_vnack=<seq>` | **[4.5]** gyártói tájékoztató nyugtázása (a szalag elrejtése; csak a megjelenítést zárja le) |
| `cl_lic=<b64url>` | **[4.6]** licenc-blob beillesztése (vendor-aláírt 'L' boríték; devId-kötött, seq-floorral; prod-ban IS él — ez az offline út) |

**broker.new blob** (`cl_bnew`; a kiadó-CLI a repo `broker_new.py`-a): `[ver=1][seq u32 BE]`
+ TLV-mezők (`[type u8][len u16 BE][body]`, ismeretlen type átugorható): `H` host, `P` port
(u16 BE), `K` pinnelt bróker-pubkey (nyers 65B `0x04||X||Y`), `C` credential
(`user\0pass` vagy claim-token), `A` app-credential (`user\0pass` — **[4.6]**, a párosító
QR-be megy tovább), `L` fallback-bróker-lista + záró 64 bájt ECDSA-P256
aláírás (nyers `r||s`, VENDOR-privkulcs; a fw a beégetett `VENDOR_EC_PUB`-bal ellenőriz).
A `seq` szigorúan monoton (a fw a `cloud.jsn` `bseq` mezőjében perzisztálja; `seq ≤ bseq`
= elutasítás). Válasz a message-bannerben: elfogadva / régi-seq / rossz-aláírás / üres.

**Gyártói csatorna** (retained, QoS0 — **[4.5]**; terv: `VENDOR_CHANNEL_PLAN.md`).
**[4.7] topic-séma** — 1 topic = 1 retained slot, ezért típusonként külön altopic
(élő lelet 2026-07-28: a közös topicon a 'B' és az 'N' kiszorította egymást):

| Topic | Retained lakó | Feliratkozás |
|---|---|---|
| `myioc/vendor/msg` | broadcast `N` tájékoztató | 4.5+ |
| `myioc/vendor/bnew` | broadcast `B` broker.new | **[4.7]** |
| `myioc/vendor/<devId>/msg` | célzott `N` (később `M`) | 4.6+ |
| `myioc/vendor/<devId>/lic` | célzott `L` licenc | **[4.7]** |

A fw-dispatcher **topic-agnosztikus** (a boríték-típus dönt), ezért a régi helyén
érkező `B`/`L` továbbra is feldolgozódik; a kiadó oldal (vendor_msg.py / licsend)
**átmeneti dual-publish**-sal mindkét topicra tesz, amíg a flotta a 4.7-es fw-re át
nem áll. NEM wildcard-feliratkozás (`vendor/#` a más eszközök célzott üzeneteit is
hozná)! Flotta-szintű **toló** út a `broker.new` húzó útjai mellé:
egyetlen publish minden eszközt elér, connect után azonnal. Boríték:
`[ver=1][type u8][seq u32 BE]` + TLV-mezők (`[fType u8][len u16 BE][body]`, ismeretlen
átugorható) + záró 64 bájt ECDSA-P256 aláírás (nyers `r||s`) — **ugyanaz a VENDOR-kulcs
és ugyanaz az ellenőrző út, mint a `broker.new`-nál**, tehát egy feltört bróker sem tud
hamis gyártói üzenetet küldeni (csak elhallgatni — ezért marad az auto-fetch a végső
mentőöv). Üzenet-típusok:

| `type` | Jelentés | Mezők |
|---|---|---|
| `B` | `broker.new` szállítása | `B` = a **teljes** broker.new blob (sima vagy obfuszkált) → a közös `verify → seq → apply` út |
| `N` | tájékoztató (a /cloud oldal szalagja + eseménynapló) | `S` súlyosság (u8: 0 info / 1 figyelmeztetés / 2 fontos), `E` lejárat (u32 BE unix; 0 = nincs), `T` `[tagLen u8][nyelv-kód][UTF-8 szöveg]` — **nyelvenként ismételhető**, `L` link (ASCII, csak `http(s)://`) |
| `L` | **[4.6]** licenc (`lic.jsn` + `lic/ack` nyugta; kiadó: fleet `licgen`/`licsend`) | `D` devId (ASCII, **kötelező** — más eszközé eldobva, a floor sem emelkedik), `F` örökös feature-maszk (u32 BE), `Y` éves maszk + lejárat (u32+u32 BE; **csak kijelzés** — az éves kapu a bróker-ACL), `I` kiadás-idő (u32 BE unix), `T` címke (UTF-8, ≤32B), `Q` párosítás-limit (u8; a `CloudPairStart` kapuzza, fw-plafon 8) |

**[4.6] licenc-transzportok:** a célzott `myioc/vendor/<devId>/msg` retained topic (a fw a
4.6-tól erre is feliratkozik) ÉS a `cl_lic` beillesztő-mező — **ugyanaz a blob, ugyanaz a
verify-út**; mindig a nagyobb `seq` győz, a forrástól függetlenül (a beégetett/kézi/topicos
út egyenrangú). Nyugta: retained JSON a `myioc/<devId>/lic/ack`-ra
(`{"v":1,"seq":…,"rc":0,"feat":"0x…","yexp":…,"fw":"…"}`) — a fleet `licstatus` ebből olvas.

**[4.7] Üzenet-előzmény (eszköz-oldali üzenet-tár):** az elfogadott `N` tájékoztatók
utolsó 6 példánya a rejtett rendszer-kötet `vmsg.jsn`-jébe kerül (külön fájl — a
cloud.jsn gyári törlése nem vágja el), és a /cloud oldal **Üzenetek** szekciója
mutatja (JS-var: `cl_vh = [[seq,at,sev,'url',{'HU':…}],…]`, verzió-kapu a jelenléte).
A `cl_vnack` **csak olvasott-vízjel** (a szalagot rejti el) — a user az üzenetet nem
törölheti; azonos `seq` újrakiadása a legfrissebb bejegyzést írja felül (nem duplikál).

**[4.7] Eszköz-állapot topic** (`myioc/<devId>/sys`, retained, a fw publikálja
változáskor): kis JSON a gyártói toolingnak (TUI részletlap nem-LAN esete) —
`{"v":1,"bseq":…,"brk":<aktív bróker-index>,"brkn":<lista-hossz>,"keys":…,"kmax":…,
"pw":<párosítás-ablak, perc>,"vnseq":…,"vnack":…,"lseq":…,"lang":"HU","fw":"…"}`.
A `lang` a setup **Default Language** (DL, EEPROM 9) nyelvkódja (0=EN, 1=HU, 2=FR,
3=DE — a langinfo.json indexelése): a gyártó ebből tudja, milyen nyelven kell az
ügyféllel kommunikálni — **célzott** vendor-üzenethez elég ez az egy nyelvi változat
(a fleet TUI/DB cache-eli, a vendor_msg.py `--dev` figyelmeztet, ha nem ezen írsz);
a **broadcast** marad többnyelvű (egy topic — vegyes nyelvű flotta). Nincs benne
user-titok (kulcs-darabszám, nem címkék); az aclgen a karanténban is engedi írni.

Fenntartva (a mai firmware **eldobja**): `U` update-available, `R` revoke,
`C` credential-rotate, `M` célzott titkosított üzenet.
**Replay:** típusonkénti `seq`-floor (`cloud.jsn` `vs<i>t`/`vs<i>q`). A politika azonos a
`broker.new`-éval: szigorúan **régebbi** `seq` elutasítva, **azonos** `seq` újra-feldolgozható
(a retained üzenet *kívánt állapot*, nem egyszeri esemény — minden újracsatlakozáskor
megérkezik; változatlan tartalomnál nincs írás és nincs napló-sor).
**Visszavonás:** új `seq` + múltbeli `E` → a szalag aláírt módon tűnik el (üres retained
payloadra a firmware szándékosan **nem** reagál: az nincs aláírva).
**HATÁR — a csatorna soha nem vezérel:** nincs olyan típus, amely parancs-útra vezetne;
ismeretlen típus eldobva. Eszközt kizárólag a fenti per-user aláírt `/cmd` mozgat.

**Jog-leíró** (`perm/<keyId>`, retained — párosításkor, jog-szerkesztéskor,
visszavonáskor és minden kapcsolódáskor frissül; a kulcs törlésekor a topic ürül):
```
{"v":1,"slot":S,"rev":0,"q":{"r":RQ,"f":FQ,"p":PCAQ,"g":GQ},
 "w":{"r":"<hex>","f":"..","p":"..","g":".."},"rd":{ugyanígy, olvasás-jog}}
```
Hex-maszk: a j. hex-karakter (nibble) az `id = 4j+1 … 4j+4` elemeket fedi, a nibble
**bit0 = első id** (LSB-first). A `g` maszk 0-bázisú csoport-index (elem-ID = 501+index),
a csoport-jog a tagokból származtatott. A leíró **megjelenítés-segítő** (az app elrejti,
amihez nincs jog) — a végső szót parancsonként az eszköz `CheckUserPermission`-je mondja ki.

A `cf` mező (**counter-floor**, opcionális) az adott kulcs utolsó **elfogadott** countere.
A kliens ennél nagyobb `counter`-t küldjön. Eszköz-újraindítás után a replay-floor a
persistált plafonra ugrik (utolsó+`CLOUD_CTR_WINDOW`), ezért a boot utáni első `perm`
üzenet ezt a megemelt értéket hordozza — a kliens a `counter`-ét `max(helyi, cf)`-re
szinkronizálja, így a régi párosítások **nem esnek replay-be** újraindítás után. A `cf`
nem titok (aláírás nélkül értéktelen).

**Soros (bench):** `?cloud.` = állapot-dump; `!cloudpair=<slot>.` = párosítás indítása
sorosról (a QR-adatokat a konzolra írja). Konfig-fájl: gyökér `cloud.jsn` (QSPI; az
eszköz-privát kulcs is itt — a fájl az eszközt nem hagyja el).

## 10/D. Flow szabálymotor **[4.4+]**

Kártya-alapú szabálymotor (FLOW_PLAN.md): WHEN (él-vezérelt trigger) / AND
(szint-feltételek) / THEN (akciólánc delay-kártyával). Konfig a QSPI-gyökér
**`flows.jsn`** fájlban (`formatVersion:1`); sapkák: 64 flow / 8 AND / 16 THEN /
32 változó. Az akciók a proxy-rétegen mennek át (védelem/joiner érvényesül).

**Mentés-út:** `PUT /flows.jsn` (fileput, editor-jog) + `flow_reload=1` POST
(info.json) — a motor újraindítás nélkül újratölt.

**HTTP-paraméterek (editor-jog):**

| Paraméter | Hatás |
|---|---|
| `flow_reload=1` | flows.jsn újratöltése (a betöltés a loop-kontextusban fut) |
| `flowen_on=<id>` / `flowen_off=<id>` | flow futásidejű engedélyezés/tiltás (fájlt nem ír; tiltásnál a futó lánc leáll) |
| `flow_fire=<id>` | kézi elsütés: WHEN/AND kihagyva, a THEN-lánc indul |
| `flow_var*<id>=<érték>` | változó azonnali beállítása (a var-triggerek kiértékelődnek; a fájlt nem írja). **[4.10.0 fix]** a kezelő korábban a rossz paraméter-ágban volt (a tokenizáló a `*`-nál megáll, így a csillagos paraméter a `*` ágba jut, a kezelő pedig az `=` ágban ült), 4.10.0 előtt hatástalan |
| `flow_whtest=<slot>` | **[4.4.1]** webhook teszt-elsütés (a BETÖLTÖTT slotot süti el, gap-fék nélkül) |

**GET `/flowtrace.json`** *(editor-jog; viewers/pollhz védelem a sysdiag-mintára)* —
élő státusz + trace. `?since=<tseq>` = csak az annál újabb trace-bejegyzések
(inkrementális poll). Mezők: `n/max` (betöltött/max flow), `err`+`errflow`
(parse-hibák), `tickmax/overrun` (büdzsé-statisztika µs-ban), `fired`, `evdrop`,
`vars` (32 érték), `flows`: `[[id, flags, pc, delayHátralékMs, utolsóElsütésMp], …]`
(flags bit0=en, bit1=armed, bit2=fut), `tseq` + `trace`:
`[[koraMs, flowId, ev, kártyaIdx, érték], …]` (ev: 1=elsült, 2=AND bukott,
3=akció, 4=delay indult, 5=kész, 6=esemény elveszett, 7=újra-trigger eldobva,
8=hiba, 9=kézi elsütés, **[4.4.1]** 10=webhook kiment (kártyaIdx=slot, érték=HTTP-kód),
11=webhook hiba (érték: −1=gap/üres slot, −2=sor tele, −3=DNS, −4=connect, −5=timeout,
pozitív=nem-2xx HTTP-kód)).

**Soros parancsok:** `?flow.` (státusz-dump: pool, flow-k, büdzsé, hibák),
`!flowfire*<id>.`, `!flowen*<id>*<0|1>.`; **[4.4.1]** `?wh.` (webhook-slotok +
számlálók), `!whfire*<slot>.` (teszt-elsütés).

**flows.jsn kártya-kulcsok** (rövid kulcsok, a szerkesztő írja; kézzel is írható):
`when`: `{"t":"sens","src":"thermo|hum|usens","ch":N|"id":N,"op":"gt|lt","val":x10,"hyst":x10}`
(thermo: `ch` = 1Wire eepromIndex 1..100, érték a ×100 nyersből ×10-re osztva;
hum: `ch` = DHT-csatorna 0..7; `src:"dht"` legacy-ként még elfogadott),
`{"t":"scmp","src":..,"ch":N|"id":N,"op":"gt|lt","src2":..,"ch2":N|"id2":N,"dv":±x10,"hyst":x10}`
(**[4.4]** szenzor-összevetés: A op B+Δ — a forrás-kulcsok a sens-sel azonosak, a B-ág
`src2`/`ch2`/`id2`; `dv` a B-hez adott előjeles Δ ×10; bármelyik oldal STALE → a kártya hamis),
`{"t":"out","id":<egységes ID>,"dir":0|1|2}`, `{"t":"time","min":<perc>,"days":<bitmaszk, bit0=hétfő>}`,
`{"t":"sun","ev":"rise|set","off":±perc,"days":m}`, `{"t":"var","id":1..32,"op":"eq|ne|gt|lt","val":n}`,
`{"t":"boot"}`; `and[]`: sens/scmp(`op`-ban `eq` is, `hyst` = sáv)/out(`"on":0|1`)/`{"t":"twin","from":perc,"to":perc,"days":m}`/var;
`then[]`: `{"t":"rel|grp","id":..,"act":0|1|2}`, `{"t":"pca|fet","id":..,"val":0..255}`,
`{"t":"delay","s":mp}`, `{"t":"var","id":..,"op":"set|inc|dec","val":n}`, `{"t":"log","val":n}`,
`{"t":"msg"}` (navbar-értesítés, M59 üzenetkód),
`{"t":"http","id":<slot 1..8>,"val":n}` (**[4.4.1]** webhook: a `val` a `$val`
helyettesítőbe kerül; a küldés aszinkron, a lánc nem vár rá).
Érvénytelen kártya → az adott flow letiltva (S_ERR), a többi fut; hiányzó/rossz
`formatVersion` → az egész fájl elutasítva.

**`hooks[]` — webhook-célok [4.4.1]** (a flows.jsn gyökerében, opcionális; a régi
fw az ismeretlen kulcsot átugorja):

```json
"hooks":[ {"id":1, "name":"ntfy riasztó", "met":1,
           "url":"http://ntfy.lan:8080/myio", "body":"$dev: $msg ($val)",
           "err":1, "gap":3} ]
```

`met`: 0=GET / 1=POST (a body csak POST-nál megy ki, `text/plain`-ként);
`url`: kötelezően `http://` (TLS nincs ezen az úton — tipikusan LAN-os ntfy/hub;
hostname mehet, a feloldás nem-blokkoló DNS-sel, cache-elve); `err:1` = automatikus
elsütés ERROR-szintű naplóbejegyzésnél (globális 60 mp-es fékkel); `gap` =
célonkénti minimum-köz mp-ben (flood-védelem, alap 3). Helyettesítők az URL-ben
és a body-ban: `$dev` (eszköznév), `$flow` (flow-id), `$val`, `$msg`
(`flow`/`errlog`/`test`). A kimenő kérés a Shelly/Link közös slotján, azok
arbiterében fut — a Shelly/Link-pollt nem éhezteti ki; hibára nincs újraküldés
(az eredmény a trace-ben és a `myio_webhook_*_total` metrikákban látszik).

## 10/E. RS485-bővítők + KNX/DALI-átjáró (/expander) **[4.5+]**

Csak RS485-bővítőbuszos (Opta) vezérlőn — GIGA-n az oldal jelenlét-kapus
üzenetet ad. A genconfig `expanders[]` (`type: "io16" | "knx" | "dali"` [4.8.5]) a web-UI
kapuzása (`exp_t[]` 0/1/2, KNX/DALI-maszk); a **tényleges paneltípust a panel mondja meg**
a `0x05 ID` válaszban (`ptype`: 16 Ext16, 17 Ext-KNX, 18 Ext-DALI és 19 Ext-WiSUN
FOGLALT). Az Ext-KNX panel a mester szemével „16 be + 16 ki + 16 szenzor”, a
csatornák KNX-csoportcímekre képződnek (KNX_PLAN.md).

**Ismert panelek nyilvántartása [4.6.2]** — `expseen.jsn` (root):
`{"expseen":{"<cím>":{"t":<ptype>,"fj":<fwMaj>,"fn":<fwMin>,"pv":<proto>,"uid":"<24 hex>","ls":<helyi epoch, 0 = ismeretlen>,"n":<bejelentkezések>}}}`.
Az M4 a relink-ID rekordban (RPC **proto v7**, `MyioExpRelink` 46 B: `ptype, fw_major, fw_minor,
proto_ver, uid[12]` — **M4+M7 PÁROS flash!**) hozza az ID-válasz 20 B-os alapját; az M7 online-átmenetkor
(NEW = új cím, IDENT = típus/fw/UID változott) és LOST-kor (utolsó látás) frissíti, 3 s debounce-szal
menti. A /expander lista = online ∪ ismert címek, cím szerint; soha nem látott cím nem jelenik meg.
evlog: `System,Expander,NEW|IDENT,addr=N,type=,fw=,proto=,uid=` / `FORGET,addr=N`.

| Paraméter | Hatás |
|---|---|
| `exs_del*<cím>=1` | ismert, **OFFLINE** panel elfelejtése (rekord + failsafe-diag törlése; a `expfs.jsn`/`expaux.jsn` beállítások maradnak); online panelre elutasítva |

JS-változók (a cím-1 indexű tömbök): `exs_t[]` (ptype, 0 = soha nem látott), `exs_fj[]`, `exs_fn[]`, `exs_pv[]`,
`exs_n[]`, `exs_uid[]` (24 hex), `exs_ls[]` (helyi epoch), `exs_now` (a vezérlő helyi ideje). Régi fw-n
(nincs `exs_t`) a JS a konfig-listára esik vissza.

**A GA-tábla igazságforrása a PANEL cfgstore-ja** — az oldal a buszon át olvas
(lap-nyitáskor) és ír (mentéskor), a vezérlőn csak RAM-árnyék él. A busz-út:
M7 `ExpRawXfer` → M4 `expRaw`/`expRawRes` RPC → expbus `0x0D KNX` parancs
(alparancsok: GATAB_WR/RD, STATUS, CFG_WR/RD, DIAG_INJ/MON — a drót-formátum
az `expbus_proto.h`-ban). Egyszerre EGY nyers tranzakció fut (egyelemű sor) —
párhuzamos kliens „busy”-t kap, adatvesztés nélkül.

**HTTP-paraméterek (editor-jog):**

| Paraméter | Hatás |
|---|---|
| `knx_sel=<cím>` | KNX-panel kiválasztása (árnyék újratöltése a panelről) |
| `knx_ga<sor>=fő/közép/al` | csoportcím a sorban (üres = sor törlése); csak az árnyékot írja |
| `knx_dir<sor>=0..3` | irány: 0=nincs, 1=bemenet, 2=kimenet, 3=szenzor |
| `knx_dpt<sor>=0..3` | DPT: 1=1.x (bool), 2=5.001 (0..255), 3=9.x (float16) |
| `knx_loc<sor>=0..15` | csatorna a panelen belül |
| `knx_tgt<sor>=0..SENQ` | cél-usensor-slot (csak szenzor-sor; mentéskor auto-enable) |
| `knx_inv<sor>` / `knx_ir<sor>` | invert / init-read flag billentése |
| `KnxSave` | a TELJES árnyék kiírása a panelre (12×GATAB_WR + 0x0C SAVE commit) |

A szenzor-út: panel `SENS`-válasz (`{id, target, rev, val10, flags}` rekordok)
→ M4 rev-szűrés → `getSens` RPC (1 Hz) → `SenSetValue(target, val10)` — a
KNX-szenzor a termosztát/napló/riasztás szemével azonos bármely uSensorral.
Bemenet-út: KNX-taszter → esemény-FIFO → gombesemény az
`abs = 8 + (cím−1)·16 + csatorna` sorszámon. Kimenet-út: PCA-parancs →
változás-összevonás + throttle (default 500 ms/csatorna) → GroupValueWrite.

**Korlát:** KNX Data Secure-ös csoportcímeket a panel nem kezel (a manual
20/C fejezete részletezi); a bővítő-online állapot a `?m4.` diagban és a
getIn-snapshot `expOnline` bitmapjében is látszik.

### 10/E.1 Ext16 1Wire-hőmérők + AUX2/3 **[4.5.10+]**

**1Wire-út:** panel (AUX1, USART3 single-wire, nem-blokkoló motor) → stabil slot-tábla
(0..15; új ROM az első szabad slotba, hiányzó ROM 3 keresés után szabadul) → `0x0B SENS`
al-kérések: `[0x00]` értékek (közös rekord `id=slot, target=0` + záró `gen` bájt; a `rev`
változásra ÉS életjelként 60 s-enként lép, mert a mester csak rev-váltást továbbít és a
hőmérő-slot 255 s-os elavulás-őre különben billentene),
`[0x01]` ROM-lista (`[n][gen][n×{slot, rom[8], flags}]`), `[0x02]` rescan → M4 tükör
(`getRoms(cím)` RPC: `[cím][gen][n][n×{slot,rom8}]`; `getSens` bejegyzés `gen` mezővel,
proto v5) → M7 `_OneWireBus.ino`: ROM → **EEPROMID** (a meglévő EEPROM 100..892 ROM-tábla,
`CheckAddress`, `sensors.bak`) → **klasszikus hőmérő-slot** `SetTempByEepromID(busz,
EEPROMID, tized×10)` (busz = (ID−1) mod 4) — így a szenzor a `sensor.json`/`sens_out.json`
„sensors” blokkjában (`{"id":ID,"temp":×100}` → app), a Bemenetek-oldal nevei
(`t_descr*<ID>`), a `t_log_<ID>` CSV, az aktivátor 1..100, a Flow 1200+ID, az MQTT
`temp/<ID>` és a Link szemével azonos a GIGA saját 1Wire-hőmérőivel. uSensor NEM vesz részt.

**AUX2/3:** 0–10 V módban a panel az **AUX2-re a saját Ki15 (PCA abs-idx (cím−1)·16+14),
az AUX3-ra a Ki16** PCA-értékét tükrözi (auxmotor `pca_write`-wrapper; 0..255 = 0..9,9 V) —
a csatorna a Kimenetek oldalon konfigurált közönséges dimmer (PWM, fade, időzítő, Flow,
keverő-termosztát), külön AUX-érték nincs. `expaux.jsn` (root): `{"expaux":{"<cím>":{"m0","m1"}}}`
(mód: 0 = 0–10 V, 1 = ledszalag [elfogadva, effekt később]); mód-váltás → `setAux` RPC
(`MyioAuxCmd`, value=0 = figyelmen kívül) → M4 expsched → `0x09 AUX SET`, online-átmenetkor
újraküldve; a panel cfgstore-jába `0x0C SAVE`. JS: `exa_m[]` (index `(cím−1)·2+pin`), `exa_pv[]`
(a tükrözött PCA aktuális értéke); a Kimenetek/PCA oldalon `expQ`/`expKnx` globálok → `AUX2/AUX3` jelvény.

**HTTP-paraméterek (editor-jog):**

| Paraméter | Hatás |
|---|---|
| `ow_rescan*1=1` | azonnali ROM-keresés minden online Ext16-panelen |
| `ow_del*<EEPROMID>=1` | nem jelenlévő szenzor regisztrációjának törlése (a slot ROM-ja nullázva, a hőmérő-slot felszabadul, az ID-k nem csúsznak) |
| `t_descr*<EEPROMID>=<név>` | a meglévő Bemenetek-oldali név-kulcs (változatlan) |

(A `*`-os kulcsok a kérésfeldolgozó csillagos ágán futnak — `ExpSettingsParamStar` —, a `knx_*`
kulcsok az `=`-ágon; mind az `info.json`-ra POST-olt `név=érték` törzsben.)
| `SensorBackup` / `SensorRestore` | a meglévő admin-parancsok: EEPROM ROM-tábla ↔ `sensors.bak` |
| `exa_m*<cím>*<pin>=<0\|1>` | AUX-mód (pin 0 = AUX2, 1 = AUX3) + panel-commit; az érték a Ki15/Ki16 PCA-csatornáé (`PCA*<id>`) |

JS-változók a /expander oldalon: `ow_q, ow_rom[], ow_seen[] (cím<<4|slot, −1 = nincs jelen),
ow_val[] (tized °C), ow_age[] (s, 65000 = soha), ow_rx`;
`exa_m[], exa_pv[]` (index `(cím−1)·2+pin`).
Diag: `?m4.` → `sensRx` (target≥1) + `owRx` (1Wire). Bench: `tools/exp_flash.py sim --ow N`,
`sens`, `aux get|set`.

### 10/E.2 Ext-DALI átjáró – nyilvántartás-modell (/dali, dali.json) **[4.8.6+]**

Genconfig: `expanders[].type: "dali"` → `MYIO_EXPT_DALI 2` + `MYIO_EXP_DALI_MASK` + `MYIO_DALI_EP_MAX`
(81 × DALI-panel); `MYIO_EXP_GW_MASK = KNX|DALI` = gateway-panelek (nincs AUX2/3, 1Wire,
failsafe-program, ROM-lista). Terv: `DALI_PLAN.md` 9.; panel-fw 0.3 (`MyIO_Exp16/app/src/dali/`).

**Modell:** végpont (ep) = `0..63` rövidcím, `64..79` csoport, `80` broadcast egy panelen; a végpont egy
PCA-csatornához csatolható (`pca` 1..PCAQ, 0 = nincs), ami NEM Ext16/KNX raszter (a DALI-panel saját
16-os blokkja + az SQ fölötti virtuális csatornák). Nyilvántartás: `dali.jsn` (root):
`{"dali":{"v":1,"pool":[lo,hi],"ep":[{"p","e","pca","fd","fr","po","sf","mn","mx","cv","g","dt","pm","f"}…]}}`
(fd fade-kód, fr fade-ráta, po power-on, sf system failure, mn/mx, cv görbe, g csoport-bitmap, dt/pm olvasott,
f: b0 létezik, b1 param-olvasás érvényes). Csatoláskor a csatorna `PCA_PWM` be.

**Szint-út:** PCA-frissítés (`PCAUpdate` → `DaliOnPcaRefresh`, rövidcím: csak változásra, dedupe az M7-en) /
`ChangePCA` → `DaliOnPcaCommand` (csoport, broadcast: MINDIG kimegy + a tag-lámpák PCA-memóriáját tükrözi,
tagság = `g`) → `IoBusSetDali` → **`setDali` RPC** (`MyioDaliCmd`, max 48 × {addr, ep, val}, proto v10,
M4+M7 páros) → M4 expsched DALI-fokozat (panelenként `dali_val[81]`, online-átmenetkor az ismert
rövidcím-szintek újra) → `0x0E LEVELS [n][n×{ep,val}]` → panel round-robin DAPC (255 → 254).

**Param-út (nem-blokkoló, `DaliTick`):** `PARAM_WR [ep][pid][val]` (pid 1 fade time, 2 fade rate, 3 power-on,
4 system failure, 5 min, 6 max, 7 görbe (DT6), 8/9 csoport add/del, 10 rövidcím-csere, 11 reset, 12 identify) →
a panelen DTR0 + STORE ×2; `PARAM_RD [ep]` → query-sor (status, actual, fade, power-on, sys-fail, min, max,
phys-min, groups, DT, version, DT6-görbe) → `PARAM_RES` 20 B. **Egészség-poll** (cfg[4] poll_mode 0/1/2,
cfg[5] periódus s): QUERY STATUS az ismert rövidcímeken → lámpahiba-bitmap (STATUS [24..31]), power-cycle bit
→ az ismert szint újraküldése (STATUS [32..33] számláló), nem válaszoló bitmap [40..47] (panel fw 0.4: **2-strike**,
két egymás utáni kimaradt válasz); mód 2: + ACTUAL LEVEL (`LEVELS_RD [start][count]`). STATUS 48 B. Failsafe (cfg[1]=1):
mester-vesztéskor broadcast OFF.

**ACTUAL-átvétel [4.8.7, panel fw 0.4]:** a panel az ACTUAL-t minden szint-parancsnál (LEVELS, power-cycle-visszaállítás,
IDENTIFY, failsafe; csoport/bcast: minden cím) 0xFF-re érvényteleníti, és csak a következő lekérdezés ad friss értéket
(a lekérdezés alatt érkező szint a választ eldobja); STATUS [38..39] = lezárt poll-körök (u16). Az M7 háttér-olvasója
(`DaliBgTick`, a param-munkasor üres állapotában, `DALI_BG_PERIOD_MS` 5 s): panelenként STATUS (absent/lámpahiba/kör-számláló a
RAM-ban), és ha poll_mode 2 + új kör → `LEVELS_RD` a csatolt rövidcímek tartományára (≤ 32/keret, 2 keret 32 fölött) →
`DaliAdopt`: friss (≠ 0xFF), nem absent, nem fade-elő (STATUS b4) lámpán, a saját küldés után `DALI_ADOPT_GUARD_MS` (3 s)
letelte után, ha a driver szintje ≠ a csatorna értéke a driver MIN/MAX-ára vágva (255 → 254) → `PCA[] + PCA_refresh`
(`_daliLast` = az új érték, így a refresh-hurok nem küld vissza DAPC-t). Számláló: dali.json `adopt`. **Panel-gotcha (fw 0.4):**
a 0-s rövidcím + szint 0 = csupa-nulla DALI-keret (0x0000), amit egyes driverek (SMT-024-200VMH) eldobnak → a panel ilyenkor
OFF parancsot (0x0100, azonnali) küld; echo-hibás szint-keretet egyszer újraküld.
**Panel-újraindulás:** a panel a POLL-státuszban `EXPBUS_ST_DALI_UNSYNC` (0x0040) bitet ad az első LEVELS-ig; az M4
erre az ismert rövidcím-szinteket újraküldi (gyors reboot, offline-átmenet nélkül is); az M7 a relink-generáció
változására szintén újraküld (M4-újraindítás után üres M4-kép ellen).

**dali.json:** `{"dali":{"epq","n","pcaq","sq","expq","expt":[0/1/2…],"pool":[lo,hi],"poolset","busy","adopt","msg",
"panels":[{"a","on","st":[48],"comm":[18],"cfg":[8]}],"ep":[{"i","p","e","pca","pv","pwm","fd","fr","po","sf",
"mn","mx","cv","g","gr","dt","pm","f","r":[fd,fr,po,sf,mn,mx,cv],"ls","act"}]}}` (pca/pool 1-alapú abs csatorna, P-id = 2000+; `gr` = a driverből
olvasott tagság, `r` = a driverből olvasott paraméterek (255 = nincs), `ls` = utoljára küldött szint, `act` [4.8.7] = a driver
friss szintje a háttér-pollból (255 = nincs), `adopt` [4.8.7] = átvett szintek száma boot óta). **dali.jsn [4.8.7]:** az ep-rekord
`"gr"` és `"r":[7]` mezővel is perzisztál (a driverből olvasott értékek újraindítás után is látszanak).

**HTTP-paraméterek (editor-jog, `info.json`-ra POST):**

| Paraméter | Hatás |
|---|---|
| `dali_scan*<panel>=1` / `dali_comm*<panel>*<mód>*<kezdő>=1` / `dali_abort*<panel>=1` | scan / felcímzés (mód 0 = mind, 1 = csak címtelen) / megszakítás |
| `dali_add*<panel>*<ep>=1` / `dali_addall*<panel>=1` / `dali_del*<i>=1` | végpont felvétele (rövidcím: PARAM_RD automatikusan) / az utolsó scan minden új címe / törlés |
| `dali_pca<i>=<P-id\|abs\|0>` | csatolás (csak megengedett, szabad csatorna; 0 = leválasztás) |
| `dali_fd/fr/po/sf/mn/mx/cv<i>=<érték>` | kívánt paraméter a nyilvántartásban |
| `dali_gt*<i>*<g>=1` | csoport-tagság billentése (kívánt) |
| `dali_rd*<i>=1` / `dali_wr*<i>=1` / `dali_ident*<i>=1` / `dali_reset*<i>=1` / `dali_sa*<i>*<új>=1` | olvasás / kiírás (fade, power-on, sys-fail, min/max ha olvasva, görbe, csoport-diff, majd újraolvasás; **csoport/broadcast végponton** egy csoport-/broadcast-címzésű parancssor minden tagba + a tagok kívánt értékei átveszik + tag-RD) / azonosítás / reset / rövidcím-csere |
| `dali_plo=<P-id>` / `dali_phi=<P-id>` / `dali_auto*1=1` | pool tól/ig / kiosztás a poolból |
| `dali_cfg*<panel>*<mező>=<érték>` | panel-cfg (0 PSU aktív-LOW, 1 buszáp tiltva, 2 failsafe, 3 hiccup s, 4 adó-komp µs, 5 poll-mód, 6 poll-periódus s) → CFG_WR + SAVE |
| `PCA*<P-id>=<0..255>` | a szokásos kimenet-út (teszt-csúszka) |

A /expander lapon a DALI-kártya csak státusz-kivonatot kap (`dali_pn/pst/pep[]`). Bench: `tools/exp_flash.py
dali levels|param|status`, `MyIO_Exp16/tests/test_dali.c` (1112 assert).

### 10/E.3 Ext-DMX átjáró – lámpatest-nyilvántartás (/dmx, dmx.json) **[4.9.0+]**

Genconfig: `expanders[].type: "dmx"` → `MYIO_EXPT_DMX 3` + `MYIO_EXP_DMX_MASK` + `MYIO_DMX_PANEL_N` +
`MYIO_DMX_FX_MAX` (64 × DMX-panel); `MYIO_EXP_GW_MASK = KNX|DALI|DMX`. Terv: `DMX_PLAN.md`; panel-fw
`expdmx` 0.1 (`MyIO_Exp16/app/src/dmx/`), expbus `0x0F` (STATUS/CFG_RD/CFG_WR/LEVELS/LEVELS_RD/FILL),
POLL-státusz `EXPBUS_ST_DMX_UNSYNC 0x0080`. RPC: `setDmx` (`MyioDmxCmd`, 48 × {addr, slot u16, val}),
proto **v11** (M4+M7 páros flash).

**Modell:** lámpatest (fx) = panel `p` + DMX-kezdőcím `a` (1..512) + típus `t` (0 dimmer 1 ch, 1 RGB 3 ch,
2 RGBW 4 ch, 3 általános `n` ≤ 16) + csatornánként PCA-csatolás `c[k]` (1..PCAQ, 0 = nincs); a k. csatorna
slotja = `a + k`. Csatolható: nem Ext16/KNX/DALI raszter (a DMX-panel saját 16-os blokkja + az SQ fölötti
virtuális csatornák), nem DALI-csatolt. Nyilvántartás: `dmx.jsn` (root):
`{"dmx":{"v":1,"pool":[lo,hi],"fx":[{"p","a","t","n","c":[…],"f"}…]}}`. Csatoláskor `PCA_PWM` be.

**Szint-út:** `PCAUpdate` → `DmxOnPcaRefresh` (csak változásra, dedupe az M7-en) → `IoBusSetDmx` →
`setDmx` RPC → M4 `expsched` DMX-fokozat (1b, `dmx_val[512]` + dirty/set bitmap) → `0x0F LEVELS`
(≤ 64 hármas/keret) → a panel univerzuma (folyamatos adás, period_ms, default 25 ms). Online-átmenet / UNSYNC
→ a valaha beállított slotok újra. Nincs csoport/broadcast szemantika (a DMX egyirányú).

**`dmx.json`:** `{"dmx":{"fxq","n","pcaq","sq","expq","expt":[0/1/2/3…],"pool":[lo,hi],"poolset","test":i,
"dbound":[DALI-csatolt virtuális csatornák],"msg","panels":[{"a","on","nfx","st":[32 B STATUS],"cfg":[8 B]}],
"fx":[{"i","p","a","t","n","c":[…],"pv":[…],"pwm":[…],"ls":[…]}]}}`. STATUS: `[1]` flagek (b0 TX_RUN, b1 DIRTY,
b2 FS_FIRED, b3 MASTER_LOST, b4 UNSYNC), `[2..3]` nslots, `[4..7]` keretek, `[8..9]` HAL-hiba, `[10..11]` késett
ütem, `[12..13]` ismert slot, `[14]` fs_state, `[15]` adó foglalt, `[16..19]` uptime s, `[20..23]` utolsó LEVELS
óta ms (0xFFFFFFFF = nincs), `[24]` period_ms, `[25]` mab_us, `[26..27]` break_us. CFG: `[0..1]` nslots,
`[2..3]` break_us, `[4]` mab_us, `[5]` fs_mode, `[6]` flags (b0 DE aktív-alacsony), `[7]` period_ms.

**POST-paraméterek** (EDITOR, `_ExpSettings.ino` → `_Dmx.ino`):

| Paraméter | Hatás |
|---|---|
| `dmx_add*<panel>*<kezdőcím>*<típus>=1` | lámpatest felvétele |
| `dmx_del*<i>=1` | törlés a nyilvántartásból |
| `dmx_test*<i>=1` | minden csatorna 255 1,5 s-ig, majd vissza a PCA-értékre |
| `dmx_bo*<panel>=1` | blackout: FILL 1..512 = 0 + a csatolt csatornák PCA-ja 0 |
| `dmx_auto*1=1` | a pool szabad csatornáinak kiosztása a csatolatlan lámpatest-csatornákra |
| `dmx_cfg*<panel>*<mező>=<érték>` | panel-cfg (0 nslots, 1 break_us, 2 mab_us, 3 fs_mode, 4 DE aktív-alacsony, 5 period_ms) → CFG_WR + SAVE |
| `dmx_c<i>_<k>=<P-id\|abs\|0>` | a k. csatorna csatolása |
| `dmx_a<i>=<kezdőcím>` / `dmx_t<i>=<típus>` / `dmx_n<i>=<n>` | kezdőcím / típus / csatornaszám (csak általános) |
| `dmx_plo=<P-id>` / `dmx_phi=<P-id>` | pool tól / ig |
| `PCA*<P-id>=<0..255>` | a szokásos kimenet-út (csúszka) |

A /expander lapon a DMX-kártya státusz-kivonatot kap (`dmx_pn/pst/pfx[]`). Bench: `tools/exp_flash.py dmx
status|levels|fill|rd|cfg`, `MyIO_Exp16/tests/test_dmx.c` (767 assert), `test_sched.c` DMX-fokozat.

### 10/E.4 KNXnet/IP ETS-illesztő (tunneling-szerver) **[4.14+]**

Az Ext-KNX panellel szerelt vezérlő **KNXnet/IP tunneling-szerver** (UDP 3671, felderítés
multicast 224.0.23.12): az ETS6 vagy bármely KNXnet/IP-kliens (knxd, Calimero, Home Assistant)
tunnelt nyit rá, és a panel TP1-buszán ad/vesz táviratokat. Nem HTTP-végpont – a webes
felület csak a kapcsolót és a státuszt adja.

- **Kapcsoló/perzisztencia:** `/expander` (4.15-től `/knx`) POST `knxip_en=<bármi>` (toggle) → `knxip.jsn` `{"en":0|1}`;
  `knxip_drop=1` = az élő tunnel bontása. A `/expander` JS-változói: `knxip_en`, `knxip_st`
  (0 ki / 1 hallgat / 2 ETS kapcsolódva), `knxip_ia` (tunnel-IA = a panel saját IA-ja, u16),
  `knxip_bus` (KNX-busz él), `knxip_cli` ("a.b.c.d"), `knxip_cnt=[connects, disconnects, req, con,
  ind, ack_to, bus_to, q_drop, bad_pkt, inject_err]`, `knxip_err` (utolsó KNXnet/IP-hibakód).
- **Protokoll-készlet (v1):** SEARCH_REQUEST(+EXTENDED), DESCRIPTION, CONNECT (CRI 04/02 =
  tunnel, link-layer; más típus → E_CONNECTION_TYPE 0x22, foglalt → E_NO_MORE_CONNECTIONS 0x24),
  CONNECTIONSTATE (120 s heartbeat-időtúllépés), DISCONNECT, TUNNELLING_REQUEST/ACK (cEMI
  L_Data.req → busz; L_Data.con + L_Data.ind vissza; 1 s ACK-várás, 1 ismétlés, majd bontás),
  TUNNELLING_FEATURE_GET (max APDU 15, IA, busz-állapot). Nincs device-management kapcsolat,
  routing, KNX IP Secure; extended keret → negatív con.
- **Út a buszra:** `0x0D` KNX-parancs `0x12 DIAG_XFER` alparancsa (injekt + monitor-ring egy
  busz-fordulóban; `expRaw` RPC, nem blokkoló), tunnel alatt 40 ms-os pollal; a panel (expknx ≥ 0.2)
  a saját IA-jára és broadcastra is nyugtáz.
- **Socket-keret (Opta, lwIP `MBED_CONF_LWIP_SOCKET_MAX` = 4):** a HTTP-figyelő + Cloud +
  webkliens + kimenő kérések a 4 netsocket-slotot folyamatosan kitöltik, ezért a 3671-es UDP
  NEM `EthernetUDP`, hanem **nyers lwIP `udp_pcb`** (`MyIO_M7/knxip_udp_raw.cpp`: udp_new/bind/
  recv/sendto + IGMP-csatlakozás a tcpip-szálban, `tcpip_callback`; ring-pufferek a loop felé) —
  nem fogyaszt slotot, bootkor azonnal nyílik. Soros napló: `KNXIP: ETS-illeszto BE (UDP 3671
  nyers lwIP pcb, …)`. A NetIf `udpBegin` bukott `begin()` után `stop()`-pal takarít és
  `[ERROR] udpBegin: nincs szabad LWIP-socket`-et naplóz (ez a többi UDP-fogyasztót érinti).
- **genconfig:** `config.knx = {"ip": true, "tunnels": 1, "knxq": 16}` → `MYIO_KNXIP` (a modul csak
  ezzel fordul be), `MYIO_KNX_TUNNELS`, `MYIO_KNXQ`; csak M7-et érint.
- **KNX-eszköz-nyilvántartás + címzés ETS nélkül (`_KnxDev.ino`, `knxdev.jsn`
  `{"knxdev":[{"ia":4353,"m":1968,"n":"név"}]}`, max `MYIO_KNXQ`):** `/expander` POST
  `knxdev_scan=1` (prog-módú eszközök: A_IndividualAddress_Read broadcast, 1,5 s gyűjtés),
  `knxdev_prog=a.l.d` (cím beírása: szabad-e → pontosan 1 prog-módú → A_IndividualAddress_Write →
  visszaolvasás → lista + DeviceDescriptorRead), `knxdev_add=a.l.d`, csillagos: `knxdev_ping*<i>=1`
  (T_Connect-ACK), `knxdev_info*<i>=1` (maszk), `knxdev_del*<i>=1`, `knxdev_n*<i>=<név>`.
  Aszinkron (1 keret egyszerre, a tunnel mellett); JS-változók: `knxdev_q`, `knxdev_busy`,
  `knxdev_rc` (1 scan ok, 2 cím beírva, 3 típus, 4 jelen, 5 nem válaszol, 6 nincs válasz, 10 foglalt
  cím, 11 nincs prog-módú, 12 több prog-módú, 13 ellenőrzés bukott, 14 buszhiba, 15 tele, 16 foglalt,
  17 rossz cím, 18 már listázva), `knxdev_rcia`, `knxdev_prog[]` (utolsó találatok), `knxdev_ia[]`,
  `knxdev_m[]`, `knxdev_age[]` (s, −1 = még nem), `knxdev_nm[]`.
- **Bench:** `tools/knxip_bench.py --host <ip> {search|describe|monitor|devinfo|progread|send|feature}`
  (ETS-szerű kliens); a mag host-tesztje `MyIO_Exp16/tests/test_knxip.c` + `knxip_sim.c`.

### 10/E.5 KNX oldal – entitások, nevek, csatolás (/knx) **[4.15+]**

A KNX-rész (GA-tábla, KNXnet/IP ETS-illesztő, eszköz-nyilvántartás) a `/expander` lapról külön
**`/knx`** oldalra került (Link → KNX, `js/knx.js`); a `/expander` KNX-kártyáján csak státusz-kivonat
(`knx_off`, `knx_stat`) és link maradt. A lap JS-var-blokkját `KnxPageVars()` adja (`_ExpSettings.ino`):
`exp_q/exp_on/exp_t[]`, `knx_addr`, `knx_senq`, `knx_pcaq`, `knx_sq`, `knx_usmin` (Optán 9: az uszenzor
1–8 az I1–I8), `knx_dirty`, a 10/E.4 `knxip_*` és `knxdev_*` változói, `knx_off`/`knx_stat[24]`, a tábla
`knx_ga/dir/dpt/loc/fl/tgt[48]`, **`knx_nm[48]`** (sor-nevek) és a csatolás-legördülők nevei
(`PCA_description[]`, `switch_description[]`, `usens_description[]`).

**KNX-entitás = egy GA-sor:** név + csoportcím + irány + DPT + myIO-elem. A myIO-elem a panel
rasztere szerint: kimenet-sor → PCA `(cím−1)·16 + loc + 1` (P-id 2000+; pl. #3 loc 0 = P2033),
bemenet-sor → bemenet `(cím−1)·16 + loc + 1` (pl. #3 loc 0 = 33-as bemenet), szenzor-sor → uszenzor
`tgt` (Optán ≥ 9). A legördülő a `knx_loc<sor>` / `knx_tgt<sor>` paramétert küldi (10/E). A tábla
igazságforrása a PANEL (`KnxSave`); a nevek a vezérlőn: **`knx.jsn`** (root)
`{"knx":{"v":1,"n":["név0",…48]}}`, slot szerint.

| Paraméter | Hatás |
|---|---|
| `knx_n<sor>=<név>` | a sor neve (max 20 karakter) → `knx.jsn` azonnal mentve |
| a 10/E `knx_*` paraméterei + `KnxSave` | változatlanok (a /knx lapról is ugyanazok mennek) |
| `knxip_*`, `knxdev_*` (10/E.4) | változatlanok, a /knx lapról |

Eszköz-oldali összekötés (GA ↔ KNX-objektum) ETS nélkül: `tools/knx_dl.py` (System B letöltő, KNX_PLAN 10.8).

## 10/F. Riasztóközpont — SIA DC-09 vevő (/alarm) **[4.5.8+]**

A vezérlő a riasztóközpont **távfelügyeleti IP-vevőjének** (ARC/CMS) szerepét tölti be:
a központ ANSI/SIA DC-09 kereteket küld TCP-n és/vagy UDP-n a beállított portra (alap
7080, **csak LAN**), a vezérlő nyugtáz és az eseményekből partíció-állapotot vezet.
Csak a GIGA/Opta (4.5.8+) firmware tudja; a Due nem. Terv/napló: `ALARM_PLAN.md`,
protokoll-réteg: `MyIO_M7/sia_proto.h` (host-tesztelt, `bench_sia/`).

**Keret (titkosítatlan):**
```
<LF> CCCC 0LLL "SIA-DCS" ssss [Rr] Ll #acct [#acct|Nri1/BA01/id5] [_HH:MM:SS,MM-DD-YYYY] <CR>
```
`CCCC` = CRC-16/ARC (poly 0xA001 reflektált, init 0; `"123456789"` → `BB3D`) az első `"`-től
a `<CR>` előtti utolsó karakterig; `0LLL` = ugyanennek a szakasznak a hossza hexában.
Token: `"SIA-DCS"` (DC-03 kódok), `"ADM-CID"` (Contact ID: `[#acct|QEEE GG ZZZ]`, Q=1 új /
3 visszaállás / 6 korábbi; a kód a DC-03-ra képződik, pl. 1130→BA, 3401→CL, 3441→NL,
1301→AT), `"NULL"` (életjel). `"*…"` (titkosított) → **DUH** válasz, nincs feldolgozás.
Válasz: `"ACK"` (a keret sorszáma/R/L/fiókja tükrözve, `[]`, opcionális GMT-időbélyeg),
`"NAK"0000R0L0[]` (CRC/hossz/keret-hiba vagy idegen fiók), `"DUH"` (titkosított).

**Esemény-osztályok (SIA-kód → hatás):** riasztás (BA BV BM FA FV GA HA PA MA QA TA WA ZA
KA SA UA EA) → partíció **3 = RIASZTÁS** + napló `E` + M64; éles (CL CA CF CP CQ CS CW CJ CK
CE CT) → **2**; részleges (NL CG) → **1**; hatástalan (OP OA OQ OS OK OJ OG OR) és törlés
(BC OC) → **0**; hiba be/vissza (AT/AR tápláz, YT XT YM / YR XR YN akku, YC YS LT / YK LR
komm., TA TT / TR szabotázs, BT FT GT HT UT ZT KT WT MT ET XE / BJ FJ GJ HJ UJ ZJ KJ WJ MJ
ER zóna) → hiba-bitmaszk; teszt (RP RX RA RY) és NULL → csak számláló; bypass (BB FB UB HB
GB / BU FU UU HU GU) → napló `I`. Partíció = `ri<n>` (hiányzó/0 → 1; ALARM_PARTQ [alap 4,
max 8, genconfig-define] felett csak napló).

**Univerzális szenzor-kötés:** `al_s<p>=<id>` — a szenzor értéke `állapot×10`
(0/10/20/30). A Flow `sens` kártyája, a relé/PCA-aktivátor (300+id), az MQTT usens-publish
és az app ezt látja. Kötéskor `sen_Enabled=1`, `sen_Refresh=0` (failsafe ki); a vezérlő 60 s-
onként újraküldi az értéket (csak már látott partícióra).

**HTTP-paraméterek (editor-jog, toggle-szemantika, `AlarmSave=1` perzisztál):** ld. 4.2.
**`GET /alarm.json`** (editor-jog):
```json
{"alarm":{"en":1,"tcp":1,"udp":0,"rx":12,"ack":11,"nak":1,"duh":0,"crc":1,"rej":0,"perr":0,
 "ev":9,"sim":0,"tr":0,"age":42,"ip":"192.168.1.60","raw":"5AC10036SIA-DCS0007L0#1234[...]",
 "p":[{"st":2,"c":"CL","z":0,"u":3,"age":42,"sen":2},{"st":0,"c":"","z":0,"u":0,"age":-1,"sen":0}]}}
```
`tcp/udp` = ÉLŐ figyelő/bind; `age` = mp az utolsó érvényes keret óta (−1 = még nem volt);
`tr` bitek: 1 AC, 2 akku, 4 szabotázs, 8 kommunikáció, 16 zóna/bővítő, 32 felügyelet-vesztés
(saját); `p[]` partíciónként: `st` 0..3, `c` utolsó kód, `z` zóna, `u` user, `sen` kötött
usens. A `/alarm` oldal ugyanezt `al_live`-ként kapja + `al_en/al_port/al_tcp/al_udp/
al_acct/al_sup/al_ats/al_partq/al_dirty/al_rst/al_senq`. A `/network` oldal `nsvc_sia`
(élő socket-szám 0..2) + `nsvc_siaport`.

**Konfig-fájl** `alarm.jsn` (QSPI gyökér): `{"alarm":{"en":1,"port":7080,"tcp":1,"udp":0,
"acct":"1234","sup":5,"ats":1,"s1":2,"s2":0,"s3":0,"s4":0}}`.

**Napló-sorok:** `System,Alarm,<fiók>,<kód>[(CID<n>)],ri=<p>,z=<zóna>[,u=<user>][,<megjegyzés>]`
(`E` szint riasztásnál → az `err:1` webhook-slotok is elsülnek; `I` egyébként),
`System,Alarm,supervision-lost` / `supervision-ok`, `<user>,AlarmSave,<en>,<port>`.
Navbar: **M64** riasztás, **M65** felügyelet-vesztés.

**Soros:** `?alarm.` (állapot-dump), `!siasim*Nri1/BA01.` (szimuláció DC-03 adatblokkal).

**Socket-költség / korlátok:** TCP-listener 1 W5500-socket (listenDepth 1), UDP-bind 1; a
TCP-regisztráció csak boot-kor (`Net.begin` előtt) → en/port/tcp-változás **újraindítást**
kér (`al_rst`), az UDP futásidőben nyit/zár. Port 1024..49151 (49152 felett a SockReap
kimenőnek nézné a bejövő klienst). Nincs titkosítás (AES), nincs vezérlés-irány
(élesítés/hatástalanítás) — arra a hardveres út (PGM + kulcsos zóna, manual 20/D A) marad;
a vezérlés-protokollok (Satel INTEGRA, Jablotron JA-121T, Hikvision ISAPI) FUTURE_IDEAS 16.
Teszt-eszköz: `sia_bench.py --host <ip> 'Nri1/BA01'` (TCP/UDP, `--cid`, `--null`, `--badcrc`,
`--enc`, `--loop`).

## 10/G. myIO Script – myIO Script **[4.10+]**

PLC-szerű kis szöveges nyelv (PROG_PLAN.md; mag: `MyIO_M7/prog_lang.h/.cpp` — Arduino-független,
host-teszt `bench_prog/`; héj: `MyIO_M7/_Prog.ino` + `prog_defs.h`). Programonként egy fájl:
**`prog/N.txt`** (QSPI-gyökér, N = 1..16 GIGA / 1..8 Opta), amely betöltéskor bytekódra fordul, és a
loop `ProgTick()`-je (PhaseMark 28, a FlowTick után) **ciklikusan** futtatja: minden ciklusban az
elejétől a végéig (PLC-scan), az állapot a változókban marad. Nincs `delay`, nincs ciklus
(`for`/`while`); vannak él- és időzítő-függvények. Egy loop-körben legfeljebb EGY program fut (atomian,
megszakítás nélkül) VAGY egy betöltés történik. Minden parancs a proxy-rétegen (`IoCmd*`) megy — a
védelem / csatoló / kimenet-időzítő érvényesül; a program nem tud többet, mint egy gomb. Ez a fejezet
AI-nak odaadható teljes nyelv-referencia. Oldal: `/prog` (editor/admin), menü: Program.

### 10/E.6 Ext-RS485 Modbus RTU mester – értelmező-tábla (/modbus, modbus.json, mbval.json) **[4.16.0+]**

Genconfig: `expanders[].type: "modbus"` → `MYIO_EXPT_MODBUS 4` + `MYIO_EXP_MODBUS_MASK` + `MYIO_MODBUS_PANEL_N`;
`MYIO_EXP_GW_MASK = KNX|DALI|DMX|MODBUS`. Terv: `MODBUS_PLAN.md`; panel-fw `expmodbus` 0.1 (`MyIO_Exp16/app/src/modbus/`,
ugyanaz a vas, mint az Ext-DMX), expbus `0x10` (STATUS / CFG_RD / CFG_WR / TAB_RD / TAB_WR / VAL_RD / RAW_START / RAW_RES /
SCAN / SCAN_RES), ptype 22, POLL-státusz `EXPBUS_ST_MB_UNSYNC 0x0100`. **Nincs új RPC**: a tábla a raw-úton (expRaw), az
értékek a 0x0B SENS úton; a SENS `flags` b4..7 = tízes **exponens** (érték = val10 × 10^exp), az M4 `MyioSensEntry.exp`
(volt `_pad`) mezőben adja át, az M7 `IoBusPumpSens` skáláz → `SenSetValue`. M4 SENS-tükör 16 → 32 slot/panel (PÁROS flash).

**Modell (a panel cfgstore rec 1-e, 520 B):** `bus_cfg` 8 B `[baud-kód, keret, timeout×10 ms, retry, gap ms, flags(b0 DE aktív-low), rsv, rsv]`;
**blokk** 8 B × 8 `[slave, func 1..4, start u16 LE (0-alapú), count, period s, flags(b0 en), rsv]`;
**mező** 8 B × 32 `[blk (0xFF üres), ofs, dtype (0 -,1 u16,2 i16,3 u32,4 i32,5 f32,6 u64,7 i64,8 f64,9 bit,10 bool), mod (b0..1 sorrend ABCD/CDAB/BADC/DCBA, b4..7 bit-index), scale i8, sf (0xFF nincs), target usens-id, flags(b0 en, b1 invert)]`;
**író-slot** 12 B × 16 `[slave, func 5/6/16, reg u16, dtype, mod (b0..1 sorrend, b4 forrás 0 relé-bit/1 PCA), off/lo u16, on/hi u16, period s, flags(b0 en, b1 invert)]`.
Mező k → SENS id k; író-slot k ← a panel 16-os raszter-blokkjának k. csatornája (P-id 2000+(cím−1)·16+k+1, SETOUT-raszter).
Nevek a vezérlőn: `modbus.jsn` `{"modbus":{"v":1,"p":[{"a","n","pr","f":[32],"w":[16]}]}}`.

**`modbus.json`:** `{"modbus":{"expq","expt":[0/1/2/3/4…],"senq","pcaq","sq","usmin":9,"msg","panels":[{"a","on","ld" (árnyék beolvasva),
"pend" (auto-SAVE vár),"name","preset","st":[32 B STATUS]|null,"cfg":[8],"blk":[[8]×8],"fld":[[8]×32],"wr":[[12]×16],
"val":[[f32,st,age s]×32],"fn":[32 név],"wn":[16 név],"raw":{"st","slave","func","d":[…]}|null,"scan":{"st","cur","f":[…]}|null}]}}`.
STATUS: `[1]` flagek (b0 RUN, b1 DIRTY, b2 BUS_OK, b3 RAW_BUSY, b4 SCAN_RUN, b5 UNSYNC, b6 MASTER_LOST), `[2..3]` kérés, `[4..5]` ok,
`[6..7]` timeout, `[8..9]` CRC, `[10..11]` kivétel, `[12]` blk_ok bitmap, `[13..15]` utolsó kivétel kód/slave/func, `[16..19]` uptime s,
`[20..23]` ms az utolsó válasz óta, `[24]` baud-kód, `[25]` keret, `[26..28]` aktív blokk/mező/író-slot. VAL st: 0 nincs, 1 OK, 2 STALE, 3 kivétel, 4 timeout.
**`mbval.json`** (2,5 s polling): `{"mbval":{"panels":[{"a","on","pend","st","val"}]}}`.

**POST-paraméterek** (EDITOR, `_ExpSettings.ino` → `_Modbus.ino`; a panel validál, a válasz hibakódja az üzenetben):

| Paraméter | Hatás |
|---|---|
| `mb_blk*<p>*<i>*<slave>*<func>*<start>*<count>*<period>=<en>` | blokk írása (TAB_WR → árnyék, 8 s után SAVE) |
| `mb_fld*<p>*<i>*<blk>*<ofs>*<dtype>*<mod>*<scale>*<sf>*<target>=<flags>` | mező írása (target > 0: az uszenzor engedélyezése) |
| `mb_wr*<p>*<i>*<slave>*<func>*<reg>*<dtype>*<mod>*<off>*<on>*<period>=<flags>` | író-slot írása |
| `mb_del*<p>*<tab 0/1/2>*<i>=1` | sor törlése (üres bejegyzés) |
| `mb_cfg*<p>*<baud>*<frame>*<timeout10>*<retry>*<gap>=<flags>` | busz-beállítás (CFG_WR, azonnal él) |
| `mb_save*<p>=1` / `mb_reload*<p>=1` / `mb_clr*<p>=1` | SAVE a panelen / árnyék újraolvasása / minden tábla ürítése + SAVE |
| `mb_raw*<p>*<slave>*<func>*<reg>*<count\|érték>=1` | nyers kérés (eredmény a modbus.json `raw`-jában) |
| `mb_scan*<p>*<from>*<to>*<func>*<reg>=1` | cím-pásztázás (eredmény `scan`) |
| `mb_n<p>_<i>=<név>` / `mb_w<p>_<i>=<név>` / `mb_pn<p>=<név>` / `mb_pr<p>=<preset-id>` | nevek (modbus.jsn) |

Presetek: `js/modbus.js` `MB_PRESETS` (adat; SDM120/230/630, XY-MD02 ellenőrzött; Deye, Growatt, Huawei, SunSpec 103 kiindulás).

### 10/G.1 Fájlformátum, direktívák

- Fájl `prog/N.txt`: tetszőleges sorvég (`\n` / `\r\n`), UTF-8 (azonosítók ASCII; `#name`-ben és
  stringben UTF-8 bájtok nyersen). Legfeljebb 8192 B (Opta 4096) → E39. A forrás streamelve
  fordul, nem kerül RAM-ba; a fordítás 5–20 ms, WDT + gomb-checkpoint etetéssel.
- **Direktívák** a fejlécben — az első valódi token előtt (komment és üres sor NEM zárja a fejlécet),
  a sor első nem-whitespace karaktere `#`:

| Direktíva | Jelentés |
|---|---|
| `#name <szöveg>` | név, ≤ 23 karakter (levágva), `"` és `\` → `'` (JSON-biztos), két vég trim; üres = nincs név |
| `#every <n>[ms\|s\|m\|h]` | ciklusidő; utótag nélkül **ms**; 100 ms … 24 h (86 400 000 ms); alap 1000 ms; tartományon kívül / ismeretlen utótag / hiányzó szám → E05 |
| `#enabled 0\|1` | alap 1; **a fájl az igazság** (a `progen*` csak RAM-szintű); más érték → E02 |
| `#onboot` | betöltés után az első tickben azonnal fut egyszer (`boot()` = 1), a periodikus ritmust nem tolja el |

  Ismételt direktíva: az ELSŐ érvényes, a többi komment (a szerkesztő is az elsőt írja át). `#` szó nélkül (`# megjegyzés`) = komment; ismeretlen
  `#xyz` a fejlécben → E02; a fejléc lezárása után ismert direktíva → E02, egyéb `#…` = komment;
  nem sor eleji `#` = komment a sor végéig.
- Komment: `//` a sor végéig. Utasítás-elválasztó: sorvég vagy `;` (több utasítás egy sorban
  szóközzel is elválasztható: `then off(3) return end`).

### 10/G.2 Lexika

- Kis/nagybetű-érzéketlen (minden azonosító és kulcsszó kisbetűs lesz).
- Azonosító: `[a-z_][a-z0-9_]*`, legfeljebb **15** karakter (E03).
- Szám: `digits[.digits]` — nincs exponens, nincs előjel a literálban (az unáris `-` operátor),
  nincs `.5` alak; `12abc` → E01, `1.` → E01. Int16-ba férő egész → `PUSHI` (nem foglal
  konstans-helyet); egyéb → konstans-tábla (64/program, dedupe; E36).
- String: `"…"`, ≤ 47 karakter, escape nincs, sorvég nem lehet benne (hiányzó záró idézőjel → E04,
  túl hosszú → E03). Csak megengedett helyen (ld. 10/G.6/10/G.7; máshol E06). String-tábla 256 B/program (E37).
- Kulcsszavak: `var if then elif else end and or not true false return`.
- Operátorok/írásjelek: `+ - * / %`, `== != < <= > >=`, `=`, `( ) [ ] ,`; a `!` csak `!=`-ben (E01).

### 10/G.3 Típusmodell

- Minden érték IEEE-754 **float32**. Igaz = nem nulla ÉS nem NaN; `true` = 1, `false` = 0; a logikai
  műveletek és összehasonlítások eredménye 0/1.
- **NaN = érvénytelen** (hibás/hiányzó szenzor, nincs időszinkron, rossz ID, üres tömb): terjed a
  számolásban; minden összehasonlítás NaN-nal → 0 (a `!=` → 1); `and`/`or`/`not` a NaN-t hamisnak
  veszi; `x/0`, `x%0`, `NaN%y` → NaN. `valid(x)` = véges (nem NaN/inf), `nan()` = NaN. A NaN sosem hiba.
- API-határ (a HAL kerekít): temp ×100 → /100 (°C); usens / hum / SDM ×10 → /10; `sens(id)=v` →
  `round(v·10)`; gvar int32 ↔ float; `pca`/`set` érték 0..255-re vágva és kerekítve; minden ID
  `ProgRoundI32`-vel kerekítve (fél felfelé, int32-telített).
- Egész pontosság 16,7 M-ig; `==` tört értékre kerülendő. Az él/időzítő rejtett állapota uint32 ms.
- `%`: `a − b·trunc(a/b)` (az eredmény előjele `a`-é).

### 10/G.4 Utasítások (EBNF-kivonat)

```
program   = {sep} {vardecl sep} {statement sep}        // var CSAK a program elején (utána E19)
vardecl   = 'var' decl {',' decl}
decl      = ident ['=' expr]                           // skalár, alap 0; az inicializátor az init-blokkba kerül
          | ident '[' intlit ']'                       // gyűrűpuffer 1..64 elem, össz ≤ 256 (E34); inicializátor → E18
statement = ident '=' expr                             // lokális változó (deklarálatlan → E10; tömbnév → E16)
          | 'gvar' '(' expr ')' '=' expr               // Flow-globális írása
          | 'sens' '(' expr ')' '=' expr               // virtuális usens publikálása
          | 'pca'  '(' expr ')' '=' expr               // = set(id, v)      (más olvasó '=' → E16)
          | call                                       // parancs / tömb-op / él / olvasó (eredmény eldobva)
          | 'if' expr 'then' block {'elif' expr 'then' block} ['else' block] 'end'
          | 'return'                                   // a scan vége
block     = {sep} {statement {sep}}
sep       = NEWLINE | ';'
expr      = orexpr ; orexpr = andexpr {'or' andexpr} ; andexpr = notexpr {'and' notexpr}
notexpr   = 'not' notexpr | cmpexpr
cmpexpr   = addexpr [('=='|'!='|'<'|'<='|'>'|'>=') addexpr]    // NEM láncolható (E04)
addexpr   = mulexpr {('+'|'-') mulexpr} ; mulexpr = unary {('*'|'/'|'%') unary}
unary     = '-' unary | '+' unary | primary
primary   = number | 'true' | 'false' | ident | ident '(' [args] ')' | ident '[' expr ']' | '(' expr ')'
args      = (string | expr) {',' expr}                  // string csak 1. argumentumként, ahol engedett
```

- **Inicializátor**: a `var x = kifejezés` csak az ELSŐ futásban (init-blokk) hajtódik végre — PLC
  „retain”: a változók ciklusok közt megmaradnak; reload (mentés, `prog_reload`, újraindítás)
  nullázza a tárat és újra lefuttatja; `stop()` + `progen*N*1` NEM nullázza. Az inicializátor
  bármilyen kifejezés lehet (olvasókkal is).
- `a[i] = v` nincs (E16, csak `push`). Parancs kifejezésben → E15. Tömbnév skalár helyén (vagy
  fordítva) → E18. Deklaráció beépített függvény nevével / kétszer → E17. If-mélység ≤ 8 (E38).
- `return` után az abban a ciklusban nem elért él/időzítő-hívások NEM frissülnek → az éleket a korai
  `return` elé írd. Az `and`/`or` NEM rövidzáras: mindkét oldal mindig kiértékelődik (szándékos — az
  élek így feltételen belül is minden ciklusban lépnek; a kifejezések mellékhatás-mentesek).

### 10/G.5 Operátor-precedencia (gyengétől az erősig)

`or` < `and` < `not` < összehasonlítás (`== != < <= > >=`, nem láncolható) < `+ -` < `* / %` <
unáris `- +`; zárójel. Kifejezés-mélység ≤ 16 (E32), fordításkor számolt verem-mélység ≤ 16 (E30).

### 10/G.6 Beépített függvények — teljes tábla

Jelölés: *R* olvasó (kifejezésben áll, NaN = érvénytelen), *K* kontextus (VM-belső), *M* matek,
*C* parancs (CSAK utasításként; a HAL `false` = elutasítva → `cmdDrops++`), *A* tömb, *E* él/időzítő.
`id|"név"`: ID-literál, kifejezés VAGY név-string (10/G.7). ID-literál fordításkor tartomány-ellenőrzött (E13).

| Hívás | Fajta | Vissza | Mit csinál | fw-leképezés (HAL, `_Prog.ino`) |
|---|---|---|---|---|
| `out(id\|"név")` | R | 0/1, NaN | kimenet állapota (relé 1..RQ, csoport 501..500+GQ, PCA 2001..) | `TurnedON(id)` a `FlowOutIdOk` szűrő után; rossz ID → NaN |
| `pca(id\|"név")` | R | 0..255, NaN | PCA-érték | `PCA[id-2001]` (2001..2001+PCAQ-1), egyéb → NaN |
| `remain(id\|"név")` | R | mp, 0, NaN | a kimenet futó időzítőjének hátralévő mp-e; 0 = nem fut; csoport → NaN | `relay_timerDefault − (millis−relay_timerRef)/1000` ha `relay_timerActive`; PCA: `PCA_timer*` |
| `in(n\|"név")` | R | 0/1, NaN | bemenet (kapcsoló) állapota, n 1..SQ | `buttonState[n-1] != 0` |
| `temp(idx\|"név")` | R | °C, NaN | 1Wire hőmérő eepromIndex 1..100; nyers −12600 / < −5500 / > 12500 (hibajel, billegés) → NaN | mellékhatás-mentes kereső az `_EepromIDByBusAndID/_tempsByBusAndID` táblán (×100 → /100) — NEM a `TempByEepromID` (az fantom-szenzort szúrna be) |
| `hum(ch)` | R | %, NaN | páraszenzor-csatorna 0..HUMQ−1 | `humidity[ch]/10` |
| `sens(id)` | R | érték, NaN | usens 0..SENQ; `sen_State != 1` (sosem jött / STALE) → NaN | `sen_Value[id]/10` |
| `sdm(id)` | R | érték, NaN | SDM630 mezők 201..221 (API 3. fejezet) | `ValueOfSDM(id)/10` |
| `gvar(n)` | R | egész, NaN | Flow-globális változó n 1..32 | `FlowVarGet(n)` (új publikus olvasó) |
| `hour()` `minute()` `second()` | R | 0..23 / 0..59 | TimeLib; nincs időszinkron (`year()==1970`) → NaN | |
| `dow()` | R | 1..7 | a hét napja, **1 = hétfő … 7 = vasárnap** | `(weekday()+5)%7+1` |
| `tod()` | R | 0..1439 | napon belüli perc (`hour*60+minute`) | |
| `sunrise()` `sunset()` | R | perc, NaN | napkelte/napnyugta perc-of-day, napi cache | `sm.sunRise()/sunSet()` (saját cache, a Flow-étól független) |
| `timesync()` | R | 0/1 | van-e érvényes idő | `year()!=1970` |
| `slot()` | R | n | aktuális slot | `actualSlot` |
| `uptime()` | K | mp | `millis()/1000` | VM-belső |
| `dt()` | K | mp | az előző futás óta eltelt valós idő; első futásban `#every` | VM-belső |
| `runs()` | K | n | eddigi futások száma (a jelenlegi előtt) | VM-belső |
| `boot()` | K | 0/1 | 1 az `#onboot` futásban | VM-belső |
| `abs(x)` | M | | abszolút érték | |
| `min(a,b)` / `max(a,b)` | M | | kisebb / nagyobb; bármelyik NaN → NaN. **Egy argumentummal, tömbnévvel** = tömb-op (A) | |
| `clamp(x,lo,hi)` | M | | `lo..hi` közé szorít; bármelyik NaN → NaN | |
| `round(x)` / `trunc(x)` | M | | kerekítés (fél felfelé) / egészrész; NaN/inf változatlan | |
| `valid(x)` | M | 0/1 | véges-e | |
| `nan()` | M | NaN | az érvénytelen érték | |
| `on(id\|"név")` | C | — | kimenet BE | `IoCmdTurnOn(id)` |
| `off(id\|"név")` | C | — | kimenet KI | `IoCmdTurnOff(id,false)` |
| `toggle(id\|"név")` | C | — | átváltás | relé `IoCmdRelayToggle`; csoport `IoCmdGroupEvent(id,2)`; egyéb: `TurnedON(id)` ? `IoCmdTurnOff` : `IoCmdTurnOn` |
| `set(id\|"név", v)` / `pca(id) = v` | C | — | PCA: érték; relé/csoport: igaz → BE, hamis → KI | PCA 2001..: `IoCmdPcaSet(id, clamp(round v,0,255))`; relé 1..RQ: `IoCmdRelayOn/Off`; csoport 501..: `IoCmdGroupEvent(id,1/0)`; FET 101..113 (`FETPWM`): `IoCmdFetSet` |
| ↳ mind a 4 kimenet-parancs | | | `ProgOutIdOk` (= `FlowOutIdOk`) hamis → elutasítva, trace `PT_REFUSED a=1`; **`IoQueryThermoActivator(id) != 0` (aktivátoros kimenet) → elutasítva, `a=2`** — a termosztát az úr; siker: trace `PT_CMD` (a = fn, val = id) | |
| `gvar(n) = v` | C | — | Flow-globális írása; n 1..32 különben elutasítva | `FlowVarSetCmd(n, round v)` — a Flow var-triggerei AZONNAL kiértékelődnek (a két motor összeérése); trace `PT_GVAR` (a=n, val) |
| `sens(id) = v` | C | — | **virtuális uSensor**: UI/Flow/MQTT/log úgy látja, mint egy valódi usens-t | `SenSetValue(id, round(v·10))`; `v` NaN → no-op (igaz; a usens failsafe-je viszi STALE-re); id kívül vagy `!sen_Enabled[id]` → elutasítva |
| `loadslot(n\|"név")` | C | — | slot (jelenet) betöltése; n 0..99 és `slotExist[n]` különben elutasítva (`a=4`); **programonként 10 s gap** (PROG_LOADSLOT_GAP_MS; közben elutasítva `a=3`, `logDrops++`) | `load=255; loadSlot=n` → `LoadChecker` (PhaseMark 16) UGYANABBAN a körben; trace `PT_SLOT` (val=n); S_INF; evlog `Prog,<id>,loadslot,<n>` |
| `log("szöveg"[, x])` / `log(x)` / `log()` | C | — | naplósor; szöveg ≤ 47 kar.; **programonként 1 s gap** (csendben eldobva, `logDrops++`) | S_INF `[prog] <id> log: <szöveg> <round x>`; evlog `Prog,<id>,log,<szöveg>[,<round x>]` (`,` / sorvég → `;`); trace `PT_LOG` (a = van-e x, val = round x) |
| `msg()` | C | — | navbar-értesítés; 1 s gap (csendben) | `message = MESSAGE_PROGNOTIFY` (**M67**); trace `PT_CMD` (a=48) |
| `hook(slot[, v])` | C | — | Flow-webhook elsütése, slot 1..WEBHOOK_MAX (8) különben elutasítva; `$val` = round v (alap 0) | `WebhookFire(slot, val, 0, 3)` — **reason 3 = prog** (új); aszinkron, a `WebhookLoop` küldi |
| `stop()` | C | — | a program leállítja magát: a scan itt véget ér, állapot KI (nem HIBA) | `OP_STOP` → `PSF_EN` törlése, `PS_OFF`, trace `PT_EN` (a=1, val=0); vissza: `progen*N*1` / reload / UI Engedélyezés |
| `push(a, x)` | A | — | új minta a gyűrűbe (tele → a legrégebbi kiesik) | `OP_APUSH` |
| `avg(a)` `sum(a)` `min(a)` `max(a)` | A | érték, NaN | a NaN-mintákat kihagyja; nincs érvényes minta → NaN | `OP_AOP` |
| `count(a)` / `full(a)` | A | n / 0/1 | betett minták száma / tele van-e | `OP_AOP` |
| `clear(a)` | A | — | kiürítés | `OP_ACLR` |
| `a[i]` | A | érték, NaN | `a[0]` = legutóbbi, `a[1]` = előtte…; `i ≥ count`, `i < 0` vagy NaN → NaN | `OP_LDA` |
| `rising(x)` `falling(x)` `changed(x)` | E | 0/1 | él az előző ciklus értékéhez képest ugyanazon a hívási helyen; az első ciklusban nincs él | rejtett cella / hívási hely (`PROG_HIDDEN_MAX` 48 → E35) |
| `ton(x, s)` | E | 0/1 | igaz, ha `x` ≥ `s` mp-e **folyamatosan** igaz (bekapcsolás-késleltetés); `x` hamis → nulláz | uint32 ms időbélyeg a cellában |
| `tof(x, s)` | E | 0/1 | `x` igaz → 1; `x` elengedése után az első hamis ciklustól `s` mp-ig még 1 (kikapcsolás-késleltetés); `s ≤ 0`/NaN → nincs tartás | |

Él/időzítő és tömb-függvény **utasításként is állhat** (eredmény eldobva) — így a cella/puffer akkor is
lép, ha az értéket nem használod. Parancs-árvíz: egy futásban legfeljebb `PROG_CMD_MAX_PER_RUN` = 16
parancs; a továbbiak eldobva (`cmdDrops++`, R07, nem fatális). Argumentumszám hiba → E14.

### 10/G.7 Név-feloldás (string az ID helyén)

**Fordításkor**, a HAL `resolve(kind, name)` horgán — az ID konstansként kerül a bytekódba, a string
nem marad meg (a futás nem olvas fájlt). A leírófájlok `<N>név</N>` formátumúak (`DspDescRead`-minta,
heap nélkül; összevetés kisbetű-érzéketlen ASCII-val, két végén trim; UTF-8 bájtok nyersen). Csak
az adott függvény **első** argumentuma lehet string.

| Fajta | Függvények | Fájl(ok), tartomány, eltolás |
|---|---|---|
| OUT | `out pca remain on off toggle set` | `r_desc.xml` (1..RQ) → `g_desc.xml` (1..GQ, +500) → `p_desc.xml` (1..PCAQ, +2000) — az első találat nyer |
| SLOT | `loadslot` | `slo_desc.xml` (0..99) + `slotExist[]` (nem létező slot = nem található) |
| TEMP | `temp` | `t_desc.xml` (1..100, eepromIndex) |
| IN | `in` | `s_desc.xml` (1..SQ) |

Nem található név → **E12** `nev nem oldhato fel: <név>` (a program HIBA, amíg a leíró vagy a forrás
nem változik → reload; átnevezés után reload kell). `sens("név")` az univerzális szenzor nevét oldja fel (`u_desc.xml`, 0..SENQ; a Sensors oldalon adott név). Egyéb string-helyek
(`hum`, `sdm`, `gvar`, `hook`, aritmetika) → E06.

ID-literál fordításkori ellenőrzése (E13; csak ha az első argumentum puszta szám-literál, kifejezés
nem): OUT → `FlowOutIdOk` (relé 1..RQ, csoport 501..500+GQ, PCA 2001..2000+PCAQ, FET 101..113 ha van);
SLOT 0..99 (a létezést futásidő ellenőrzi); TEMP 1..100; IN 1..SQ; SENS 0..SENQ; negatív/tört literál
→ E13. Változóból/kifejezésből jövő ID-t a HAL futásidőben ellenőrzi: olvasó → NaN, parancs →
elutasítva (`PT_REFUSED a=1`, `cmdDrops++`).

### 10/G.8 Hibakódok — teljes lista

**Fordítási hibák** → a program `PS_ERR` (3), a régi bytekód NEM marad (a fájl és a futó kód nem
térhet el); `err` = `"<sor>:<oszlop> E<xx> <szöveg>[: <részlet>]"` (≤ 63 kar., ASCII), pl.
`12:5 E10 ismeretlen nev (var kell): foo`. Szövegek = `ProgErrName()`:

| Kód | Szöveg | Mikor |
|---|---|---|
| E01 | `ismeretlen karakter` | tiltott jel, `!` nem `!=`-ben, `12abc`, `1.` |
| E02 | `direktiva csak a fejlecben / ismeretlen direktiva` | `#name/#every/#enabled/#onboot` az első utasítás után; ismeretlen `#xyz` a fejlécben; `#enabled` nem 0/1 |
| E03 | `tul hosszu nev vagy szam` | azonosító > 15 kar., string > 47 kar., túl nagy egész |
| E04 | `vart` + részlet | hiányzó `then`/`end`/`(`/`)`/`]`/`=`/`nev`/`utasitas`; láncolt összehasonlítás (`and/or (lancolt osszehasonlitas nincs)`); záratlan string; `elif/else/end` if nélkül |
| E05 | `#every 100ms..24h (ms/s/m/h)` | tartomány / utótag / szám hiányzik |
| E06 | `string csak nev- vagy log-parameterkent` | string rossz helyen |
| E10 | `ismeretlen nev (var kell)` | deklarálatlan azonosító |
| E11 | `ismeretlen fuggveny` | nincs ilyen beépített |
| E12 | `nev nem oldhato fel` | név-string nem található a leíróban / slot nem létezik / `sens("…")` |
| E13 | `ID tartomanyon kivul` | ID-literál a fajta tartományán kívül, negatív vagy tört |
| E14 | `rossz argumentumszam` | |
| E15 | `parancs kifejezesben` | pl. `x = on(3)` |
| E16 | `nem ertekadhato` | `arr[i] = …`, `temp(1) = …`, függvénynév bal oldalon |
| E17 | `foglalt nev` | kettős deklaráció, beépített függvény neve |
| E18 | `tomb/skalar keveres` | tömbnév skalár helyén, skalár tömb-függvényben, tömb inicializátor |
| E19 | `var csak a program elejen` | `var` az első nem-var utasítás után |
| E30 | `tul osszetett kifejezes (verem)` | fordításkori verem-mélység > 16 |
| E31 | `a program tul hosszu (kod)` | > 768 utasítás (Opta 384) |
| E32 | `tul mely kifejezes` | kifejezés-mélység > 16 |
| E33 | `tul sok valtozo` | > 48 (Opta 32) |
| E34 | `tomb-meret (1..64, osszesen 256)` | méret nem egész / 0 / > 64 / > 8 tömb / össz > 256 (Opta 32/4/96) |
| E35 | `tul sok el/idozito` | > 48 él/ton/tof hívási hely (Opta 24) |
| E36 | `tul sok konstans` | > 64 nem-int16 konstans (Opta 32) |
| E37 | `tul sok szoveg` | string-tábla > 256 B (Opta 128) |
| E38 | `tul mely if` | > 8 szint |
| E39 | `a forras tul hosszu` | > 8192 B (Opta 4096) |
| E99 | `a fajl nem nyithato` | héj-oldali: `SD.open` sikertelen |

**Futásidejű** (fatális → `PS_ERR` azonnal, `err` = `"R<xx> futasideju hiba pc=<n>"` ill.
`"R02 ido-sapka <us> us (3-szor)"`; trace `PT_RERR` (a = Rxx, val = pc)):

| Kód | Jelentés |
|---|---|
| R01 | utasítás-sapka: > 2000 VM-utasítás egy futásban (`PROG_INSTR_CAP`; ciklus nélkül gyakorlatilag elérhetetlen) |
| R02 | kemény idő-sapka: egy futás > 2000 µs (`PROG_RUN_HARD_US`) **3× egymás után** (`PROG_OVERRUN_LIMIT`); minden egyes túllépés `ovr++` + trace `PT_OVER` (val = µs) |
| R03 | verem-sérülés (belső) |
| R04 | ismeretlen opcode / érvénytelen image (belső) |
| R05 | ugrás kódon kívül (belső) |
| R06 | *nem fatális számláló*: HAL-parancs elutasítva (`cmdDrops`, trace `PT_REFUSED`: a = 1 rossz ID / 2 aktivátoros kimenet / 3 gap (loadslot) / 4 slot nincs; val = ID) |
| R07 | *nem fatális számláló*: parancs-árvíz (> 16 parancs/futás, `cmdDrops`) |

Puha büdzsé: futás > 200 µs (`PROG_TICK_BUDGET_US`) → `ovr++` (csak számláló). Hiba-értesítés: **M66**
navbar egyszer állapot-átmenetenként (`PGF_NOTIFIED`), S_ERR `[prog] prog/N.txt: <err>`, evlog
`Prog,<id>,err,<err>`; fordítási hibánál trace `PT_CERR` (a = sor ≤ 255, val = oszlop). A `PS_ERR`
program nem ütemeződik és kézzel sem futtatható — javítás + reload (`prog_reload=N`) kell.

### 10/G.9 Ütemezés

- Betöltéskor `nextRun = now + every`; esedékes, ha `(int32)(now − nextRun) ≥ 0`; **`#onboot`**: az
  első tickben azonnal (`boot()` = 1), a ritmust nem tolja. Egy loop-körben legfeljebb EGY program
  fut (round-robin kurzor), vagy EGY betöltés (a reload-maszk bitjei programonként, egy/kör).
- Futás után `nextRun += every` (drift-mentes); ha a lemaradás > every → `nextRun = now + every`,
  `lag++` (**kihagyás, nem burst**). `dt()` a valós eltelt időt adja. A kiadott parancsokat a 16-os
  (LoadChecker) és 17-es (OutputRefresh) fázis ugyanabban a körben hajtja végre.
- Kézi futtatás (`prog_run` / `!progrun*`): a következő körben egy teljes scan, **tiltott programon
  is**, ha a fordítása jó (HIBA programon nem); a ritmust nem változtatja; trace `PT_MAN` (val = µs).
- Engedélyezés (`progen*N*1`): `nextRun = now + every`, állapot RUN; tiltás: RUNNOW/BOOT is törlődik,
  állapot KI; trace `PT_EN` (a = 0, val = 0/1). `stop()`: KI (trace `PT_EN` a = 1). A RAM-szintű
  engedélyezés újraindításkor a fájl `#enabled` sorára áll vissza.
- Állapotok (`st`): **0** üres (nincs fájl) · **1** kikapcsolva (`#enabled 0`, `progen*0`, `stop()`) ·
  **2** fut · **3** HIBA. Flow és Program ugyanarra a kimenetre egy körben: az utolsó író nyer (a
  Program a Flow után fut).

### 10/G.10 Példaprogramok (bench_prog/progs/1..6.txt)

```
#name Ping-őr
#every 500ms
// A szerver 5 s-onként on("ping")-et küld; a "ping" relén 5 s-os időzítő van.
// TÉNY (_switch_events.ino:729): a TurnOnRelay BEkapcsolt relén NEM indítja újra az
// időzítőt -> a relé a pingek ellenére ki-be billeghet (5 s BE / akár ~5 s KI).
// Ezért nem a nyers állapotot, hanem a "12 s folyamatos csend"-et figyeljük.
var lost
lost = ton(not out("ping"), 12)        // igaz, ha 12 s-e folyamatosan nincs ping
if rising(lost) then                   // CSAK az átmenet pillanatában -> egyszer
  loadslot("Safemode")
  log("ping elveszett - Safemode")
end
if falling(lost) then log("ping visszatert") end   // újraélesedett
```

```
#name Átlag-összevetés
#every 5s
var a[10], b[10]
push(a, temp(12))                      // 1Wire eepromIndex 12 (°C; hibánál NaN kerül be)
push(b, temp(13))
if full(a) and full(b) and avg(a) > avg(b) then   // avg a NaN-okat kihagyja
  on(5)
else
  off(5)
end
```

```
#name Fűtés nappali
#every 2s
var want = 21.5                        // betöltéskor inicializált célérték
var t
t = temp(7)
if not valid(t) then off(3) return end          // szenzorhiba: fűtés le
if t < want - 0.3 then on(3)
elif t > want + 0.3 then off(3)
end
```

```
#name Előremenő-visszatérő delta
#every 10s
var d
d = temp(21) - temp(22)
sens(40) = d                           // usens 40 (x10-re kerekítve): UI/Flow/MQTT látja; NaN = nincs injektálás
if valid(d) and d > 15 then on(9) elif valid(d) and d < 8 then off(9) end
```

```
#name Éjszakai mozgásfény
#every 200ms
var night
night = tod() >= 22*60 or tod() < 6*60          // nincs időszinkron -> NaN -> hamis
if night and rising(in(17)) then on(12) end     // mozgás-él: BE
if ton(not in(17), 180) then off(12) end        // 3 perc nyugalom: KI (idempotens)
```

```
#name Kapu-számláló
#every 100ms
var n
if rising(in(5)) then n = n + 1 end
if rising(hour() == 0) then n = 0 end           // éjfélkor egyszer nulláz
gvar(7) = n                                     // Flow var-trigger azonnal látja
if n >= 100 then msg() n = 0 end
```

### 10/G.11 HTTP-felület

| Kérés / paraméter | Jog | Hatás |
|---|---|---|
| `PUT /prog/<N>.txt` (törzs = forrás) | editor | a program-fájl írása (fileput, QSPI-gyökér). **A fw a fájlt soha nem írja**, csak ez a PUT. Nem atomikus (előbb töröl) → az UI csak `200 OK` után küld reload-ot |
| `GET /~q/prog/<N>.txt` | editor/admin (user-jog 2 → 403) | a forrás letöltése `text/plain` |
| `GET /prog` | editor/admin | oldal-keret (a törzset `js/prog.js` írja); JS-változók: `prog_max, prog_srcmax, prog_everymin, prog_codemax, prog_localsmax, prog_arrmax, prog_arrcap, prog_rq, prog_gq, prog_pcaq, prog_sq, prog_senq, prog_gvars, prog_fet`, `relay/group/PCA/switch/slot/thermo_description[]`, `prog_slots[]` (létező slotok), `prog_thermo[]` (jelenlévő 1Wire eepromIndexek) |
| `prog_reload=<N\|0>` | editor | `prog/N.txt` újratöltése + újrafordítása a tickben (egy program/kör); `0` = mind; a lokális tár nullázódik |
| `prog_run=<N>` | editor | kézi egyszeri futtatás (tiltott programon is; HIBA/üres → nem) |
| `progen*<N>*<0\|1>` | editor | RAM-szintű engedélyezés/tiltás (fájlt nem ír; `1` hibás programon → „eloszor reload”) |
| `fm_del?vol=q&f=/prog/<N>.txt` majd `prog_reload=<N>` | editor | törlés a meglévő FM-végponttal → a hely üres (`st` 0) |
| `flow_var*<id>=<érték>` | editor | a Flow-globálisok kézi írása (a Script oldal is ezt használja; 4.10.0-ban javított ág) |

**`GET /prog.json[?since=<tseq>]`** *(editor/admin; `viewers` ≤ 4 / `pollhz` a flowtrace-mintára)*:

```
{ "up":<üzemidő s>, "max":16, "srcmax":8192, "everymin":100, "tickmax":<µs>, "runmax":<µs>,
  "err":<hiba-értesítések száma>, "reload":<0|1 függő újratöltés>,
  "progs":[ {"id":1,"st":0},                              // üres hely: csak id + st
            {"id":2,"st":2,"en":1,"name":"Ping-őr","every":500,"boot":0,
             "runs":1234,"last":<mp az utolsó futás óta; -1 = még nem>,"us":<utolsó futás µs>,
             "max":<max µs>,"ovr":<büdzsé-túllépések>,"drops":<eldobott/elutasított parancs>,
             "lag":<kihagyott periódus>,"code":<utasítás-szám>,
             "el":<hiba-sor>,"ec":<hiba-oszlop>,"err":"<hibaszöveg>",
             "ln":["lost"],"lv":[0],                       // lokális nevek + értékek (NaN → null)
             "an":["a","b"],"av":[[10,10,21.37],[3,10,null]] }, … ],   // tömbök: [count, cap, utolsó]
  "n":<nem üres programok>, "gvars":[32 egész],
  "tseq":<trace-számláló>, "trace":[[<koraMs>,<progId>,<ev>,<a>,<val>], …],
  "viewers":1, "pollhz":1 }
```

`st`: 0 üres / 1 kikapcsolva / 2 fut / 3 HIBA. Trace `ev` (`ProgTraceEv`, `prog_defs.h`): **1** betöltve
(val = kódméret) · **2** fordítási hiba (a = sor, val = oszlop) · **3** parancs (a = fn-id: 40 on, 41 off,
42 toggle, 43 set, 48 msg, 49 hook; val = cél-ID) · **4** log (a = van-e érték, val) · **5** futásidejű
hiba (a = Rxx, val = pc) · **6** idő-sapka túllépés (val = µs) · **7** engedélyezés (val 0/1; a = 1 ha
`stop()`) · **8** kézi futtatás (val = µs) · **9** slot betöltve (val = N) · **10** gvar írás (a = n, val)
· **11** elutasítva (a: 1 rossz ID / 2 aktivátoros kimenet / 3 gap-árvíz / 4 slot nincs; val = ID).
A ring 128 bejegyzés; `?since=` = csak az annál újabbak. Számok: NaN/inf → `null`, egész → egész,
tört → 2 tizedes.

### 10/G.12 Soros parancsok

`?prog.` — státusz-dump: `init/max/slot-méret/tickMax/runMax/err/trace/reloadMask`, majd programonként
`[id] "név" st=RUN|OFF|ERR every runs last max ovr drops=<cmd>/<log> code loc arr edge [lag]`,
hibaszöveg, és a lokális változók `név=érték` soronként. `!progreload*<id|0=mind>.`,
`!progrun*<id>.`, `!progen*<id>*<0|1>.`. S_INF/S_ERR sorok `[prog] …` prefixszel (`log` szint).

### 10/G.13 Perzisztencia, biztonság, szabályok

- A fw a `prog/` fájlokat **soha nem írja**; az UI engedélyező kapcsolója a `#enabled` sort írja át a
  szövegben → PUT → reload. Hiányzó fájl = üres hely (nem hiba). Csonka/hibás fájl → HIBA + M66, a
  többi program fut. A `prog/` mappát a ColdInit hozza létre (`SD.mkdir`).
- A nyelvben nincs fájl-, EEPROM- vagy beállítás-írás, nincs hálózati kérés (a `hook` a Flow
  webhook-céljain át megy), nincs `Serial`; a VM-ből `_requestString_event` tilos. Olvasók
  mellékhatás-mentesek.
- Aktivátoros (termosztát-vezérelt) kimenetre a parancs elutasítva (precedens: a Link sem alkalmaz
  távoli állapotot ilyen kimenetre). Minden parancs a proxy-rétegen (védelem/csatoló/időzítő).
- A `prog/N.txt` statikus úton minden hitelesített usernek kiszolgálódik → **a forrásban titok nincs**;
  a `/~q/prog/` út user-jog 2-nek 403.
- Reserved-String: a pool egyszeri SDRAM-foglalás (`MqttTlsSdramAlloc`, GIGA ≈ 104 KB: 16 ×
  `ProgSlot` + 128 trace), a loop alatt nulla heap; Optán belső heap (init-körű), felezett sapkák.
- Sapkák (`prog_lang.h` / `prog_defs.h`, genconfigból felülírhatók): `PROG_MAX` 16/8, `PROG_SRC_MAX`
  8192/4096, `PROG_CODE_MAX` 768/384, `PROG_CONST_MAX` 64/32, `PROG_STR_MAX` 256/128,
  `PROG_LOCALS_MAX` 48/32, `PROG_ARRAYS_MAX` 8/4, `PROG_ARR_ELEMS_MAX` 256/96, `PROG_ARR_CAP_MAX` 64/32,
  `PROG_HIDDEN_MAX` 48/24, `PROG_STACK_MAX` 16, `PROG_IF_DEPTH_MAX` 8, `PROG_EXPR_DEPTH_MAX` 16,
  `PROG_EVERY_MIN/DEF/MAX_MS` 100/1000/86 400 000, `PROG_INSTR_CAP` 2000, `PROG_CMD_MAX_PER_RUN` 16,
  `PROG_TICK_BUDGET_US` 200, `PROG_RUN_HARD_US` 2000, `PROG_OVERRUN_LIMIT` 3, `PROG_LOG_GAP_MS` 1000,
  `PROG_LOADSLOT_GAP_MS` 10 000, `PROG_MSG_GAP_MS` 1000, `PROG_TRACE_N` 128.
- Eseménynapló-sorok: `Prog,<id>,log,<szöveg>[,<érték>]`, `Prog,<id>,loadslot,<n>`, `Prog,<id>,err,<hibaszöveg>`.
  Navbar: **M66** program hibára leállt, **M67** program-értesítés (`msg()`).

## 11. Kliens-receptek

**Állapot-poll (ajánlott minta):**

```
induláskor: GET /info.json            → képességek, verzió
            GET /d_sens_out.json      → nevek + teljes állapot
utána:      GET /sens_out.json        1-2 másodpercenként
```

**curl-példák:**

```bash
# 5. relé bekapcsolása
curl -u user:pass 'http://192.168.1.50/command:r_ON=5'

# dimmer 50%-ra
curl -u user:pass 'http://192.168.1.50/command:PCA*2001=128'

# hőmérséklet beküldése a 3. univerzális szenzorba (21.5 fok)
curl -u user:pass 'http://192.168.1.50/command:usens*3=215'

# állapot lekérdezése
curl -u user:pass 'http://192.168.1.50/sens_out.json'
```

**Böngészős kliens (fetch):**

```js
const base = 'http://192.168.1.50';
const hdr  = {Authorization: 'Basic ' + btoa('user:pass')};
const st   = await (await fetch(base + '/sens_out.json', {headers: hdr})).json();
await fetch(base + '/command:r_INV=5', {headers: hdr});   // válasz HTML, nem kell parse-olni
```

## 12. Buktatók (fontos!)

1. **×10 fixpont** mindenhol: 21,5 °C = `215`; a PCA-szint viszont 0–255 nyers érték.
2. **Kulcsok hiányozhatnak** a JSON-ból (jog-szűrés) — iterálj a kapott kulcsokon,
   ne fix indexeken.
3. **Egy kérés egyszerre**, `Connection: close`, poll ≥ 1 s — a vezérlő socketjei végesek.
4. A `command:` válasza HTML nyugta, **nem** tartalmazza az új állapotot — poll-ból olvasd vissza.
5. Csoport-ID: a parancsok 1–20-at és 501–520-at is elfogadnak; a JSON mindig 501+-t ad vissza.
6. A billenő (toggle) konfig-parancsok (`relaysInvert=<id>` stb.) **invertálnak**, nem
   beállítanak — előbb olvasd ki az aktuális állapotot.
7. A 3.12.2 (Due) firmware-ből a **[4.x]** jelű funkciók hiányoznak (Network-parancsok,
   Shelly, usensor, Link, webes OTA, naplószintek stb.) — a dokumentum eleji
   verzió-jelölés szerint, futásidőben a `version` mezőből (`info.json`) dönts.
8. A webhook kivételével **minden** végpont auth-ot kér; 401 esetén a hitelesítést javítsd,
   ne ismételgesd a kérést.

## 13. Beállítás-varázsló — parancs-leképezés **[3.12+]**

A webes felület varázslója (`js/wiz.js` + `js/wizflow.js`) nem használ saját végpontot:
a fejezetek válaszaiból ugyanazokat a konfig-parancsokat állítja elő, amiket a beállító
oldalak. Két dolgot érdemes tudni róla, ha hasonló automatizálást írsz:

- **Írás POST-tal.** A varázsló `POST /info.json` törzsében küldi a `&`-fűzött parancsokat,
  nem `GET /command:`-mel. Oka: a GET-út **nem URL-dekódol**, ezért ott az ékezetes vagy
  szóközös név elromlana. A POST-törzs dekódolódik (`+` → szóköz, `%xx` → bájt), a
  hosszkorlát 1024 bájt, túllépéskor a vezérlő hibát jelez (nem csonkít csendben).
- **Toggle-fegyelem.** A billenő parancsokat csak akkor küldi ki, ha a kívánt érték eltér a
  jelenlegitől — különben két azonos parancs kioltaná egymást (ld. 12. fejezet 6. pontja).

| Fejezet | Előállított parancsok |
|---|---|
| Alapbeállítások | `MYIOname=<név>`, `tz=<óra>`, `latitude=<fok>`, `longitude=<fok>` |
| Szenzorok | `t_descr*<eeprom-id>=<név>`, `h_descr*<i>=<név>` |
| Kimenetek | `r_descr*<i>` / `p_descr*<i>`, `relaysJustOn=<i>` / `PCAJustOn=<i>` (billenő), `r_timer*<i>` / `PCA_timer*<i>` |
| Védelem | `relayProtection*<p>*0`, `relayProtection*<p>*1`, `protectionPriority=<p>` (billenő, **0-alapú**) |
| Csatoló | `relayJoiner*<p>*0`, `relayJoiner*<p>*1`, `joinerJustON=<p>` (billenő, 0-alapú) |
| Csoportok | `g_descr*<g+1>=<név>`, `relay_group*<g>*<hely>=<cél-ID>` (**a leíró 1-, a tagok 0-alapúak**) |
| Bemenetek | `s_descr*<i>=<név>`, `switchEnabled=<i>` (billenő), `hitEvent*<i>=<cél-ID>`, `switchNC=<i>` (billenő) |
| Logikák | `thermoActivator*<i>` / `PCA_thermoActivator*<i>`, `min_temp_ON*<i>` / `PCA_temp_MIN*<i>`, `max_temp_OFF*<i>` / `PCA_temp_MAX*<i>` |
| Mentés | `slo_descr*<slot>=<név>`, `sav_all=<slot>` |

**Bemenet-felismerés (tanuló mód).** A varázsló a `sens_IO.json` `inputs` szekcióját
pollozza 2 mp-enként, és az állapot-váltásból (0→1) ismeri fel a megnyomott bemenetet.
Mivel ez **állapot és nem esemény** (ld. 5.1), a rövid gombnyomás elveszhet — ezért a
felület azt kéri, hogy a felhasználó tartsa nyomva a kapcsolót. Ha a válasz nem tartalmaz
`inputs` szekciót (régebbi firmware), a varázsló a `reqSwitches.js` `lastSwitch` értékére
vált — az esemény-jellegű, tehát a rövid nyomást is elkapja, de csak egyet mutat.

> **A képességet próbából állapítja meg, nem verziószámból** — mert az `inputs` szekció
> jogosultság-szűrés miatt is hiányozhat, nem csak régi firmware-en.
>
> *Történet:* a `VersionCheck` (`js/func.js`) korábban a `substring(2)` utáni
> `parseFloat`-tal hasonlított, ami a harmadik tagot tizedesjegyként olvasta
> (`"3.12.10"` → `12.1`), így minden ≥10-es harmadik tagnál tévedett — a **3.12.10-es
> firmware megbukott a `3.12.9` minimumon** (eltűnt a Smart Grid menüpont), a **4.3.2
> viszont átment a `4.3.12`-n**, és a 4.3.9–4.3.11 verziókon kikapcsolva maradt a
> napkelte-eltolás (`4.3.8` kapu). **2026-07-25-én javítva:** tagonkénti, szemantikus
> összehasonlítás (`VersionParts`), a „magasabb főverzió minden korábbi minimumot
> teljesít" szabály megtartásával. Őrzők: `vertest.js` (500 pár) és `wiztest.js` 9. blokkja.

**Index-alapok (gyakori hibaforrás):** a relé/bemenet-billentők 1-alapúak
(`relaysJustOn=3` = 3. relé), a `protectionPriority` / `joinerJustON` / `relay_group`
viszont 0-alapú. A PCA billenőjének neve **aláhúzás nélküli** (`PCAJustOn`), a küszöbei
pedig `PCA_temp_MIN` / `PCA_temp_MAX` — nem `PCA_min_temp_ON`.

### Virtuális feltétel-kimenet (a „ha…akkor” mintája)

A 4.4-től a feltételes logika elsődleges eszköze a **Flow szabálymotor** (10/D. szakasz);
a 3.x-en, illetve ahol egy kimenet-állapotra más beállításnak kell hivatkoznia, továbbra is
él ez a minta: egy **fizikailag be nem kötött logikai kimenet** adja a „ha…akkor”-t —
szenzor kapcsolja, más beállítások pedig hivatkoznak rá.

```
# "Nappal van" jelző a 7. relén
thermoActivator*7=255      # 255 = Nap
min_temp_ON*7=1            # 1 = napkeltekor BE
max_temp_OFF*7=2           # 2 = napnyugtakor KI
r_descr*7=Nappal%20van

# tiltás belőle: a jelző az ELSŐ (nyertes) tag, prioritással
relayProtection*1*0=7      # jelző
relayProtection*1*1=1      # a tiltott kimenet
protectionPriority=1       # a pár indexe (0-alapú), billenő
```

A `r_delay*<i>` **negatív** értéke a nap-eseményt előre hozza (`-1800` = fél órával a
napkelte/napnyugta előtt) — ez a felületen sehol nem szerepel, csak itt.

**Korlát:** a védelem *utólag* kapcsol le (a `RelayProtection()` a főciklusban fut), tehát a
tiltott kimenet az első kísérletnél egy pillanatra bekapcsolhat; a türelmi idő
(`protCooldown`, alap 10 s) alatt a további kísérletek már el sem indulnak.

## Bővítő failsafe / standalone / elérhetőség [4.6]

Terv: `EXPANDER_FAILSAFE_PLAN.md`. Busz-protokoll (`expbus_proto.h`, `expbus_prog.h`):

- **0x05 ID kiterjesztés** (a 20 B-os alap után, additív): `fs_state` (0 WAIT / 1 LINKED / 2 FAILSAFE), `fs_mode`,
  `fs_count`, `rst_flags` (b0 IWDG, b1 PIN, b2 SW, b3 POR), `iwdg_count`, `cfg_crc` u16, `rules_crc` u16,
  `out_bitmap` u16, `out_img[16]` (a PCA-ra írt FIZIKAI értékek). Az M4 relinkkor kéri, a képet átveszi az árnyékba.
- **0x04 CFG** TLV `[key][len][val…]…` → `[st]`; `[0xFF]` = GET (teljes lista). Kulcsok: 0x01 fs_mode u8, 0x02 fs_timeout u16 ms,
  0x03 master u8, 0x04 preset u8[16], 0x05 debounce u8, 0x06 in_invert u16, 0x07 in_press_ms u16, 0x08 txinv u8,
  0x09 out_invert u16, 0x0A rules_linked u8, 0x0B thermo_stale u8, 0x0C thermo_stale_per u16 s, 0x0D prog_locked u8,
  0x7E test_hang (IWDG-bench), 0x7F preset_capture. RAM-ba ír, `0x0C SAVE` véglegesít (cfgstore rec 1).
- **0x08 BIND** `WR [1][start][count≤6][count×8B]`, `RD [2][start][count]`, `CLR [3]`, `CRC [4]` → `[4][crc u16][rows]`.
  Sor: `{type,src,dst,mode,p1 i16,p2 i16}`; típusok 1 INPUT (mode = trigger<<4 | akció), 2 THERMO, 3 PROTECT, 4 JOINER, 5 GROUP.
- Státuszbit `EXPBUS_ST_FAILSAFE` (0x0020): failsafe-ben van/volt a relink óta (a relink utáni első POLL-válaszban még látszik).
- **M4↔M7 RPC v6**: `getExpRelink` (MyioExpRelink rekordok, gen-dedup), `expReqId` (ID-kérés egy címre), `InSnapshot.expRelinkGen`. **M4+M7 PÁROS flash!**
- **RPC v7 [4.6.2]**: a `MyioExpRelink` 46 B — az ID-válasz alapja is benne (`ptype, fw_major, fw_minor, proto_ver, uid[12]`; batch 6/hívás) → `expseen.jsn` ismert-panel nyilvántartás (10/E).

Opta-oldal (`_ExpProgram.ino`):

- JSON: minden bővítő-eredetű elem (`PCA`, `inputs`, `sensors` [klasszikus hőmérő EEPROMID], `groups`) `"off":1` mezőt kap, CSAK ha a gazda-bővítő offline
  (hiánya = elérhető). `info.json`: `"exp_q"`, `"exp_online":[cím…]`. Web var-blokk: `expOn` (bitmaszk), `expQ`.
- MQTT: `<base>/exp/N/status` = online|offline (retained); a bővítő-elemek HA discovery-je `availability` listát kap (`<base>/status` + `<base>/exp/N/status`, `avty_mode: all`).
- evlog: `System,Expander,LOST,addr=N` / `BACK,addr=N,fs=<state>/<mode>,fsCount=,rst=,iwdg=,prog=match|DIFF[,locked]` / `PROG,addr=N,rows=,crc=` / `PROG-FAIL,…` / `OFFLINE,addr=N,boot`.
- Beállítások: `expfs.jsn` (root) `{"expfs":{"<cím>":{"fs","to","ma","rl","rt","as","ts","tp","pre":"<32 hex>"}}}`.
- Web-paraméterek: `exf_fs<cím>=0..3`, `exf_to<cím>=s`, `exf_ma<cím>=0|1`, `exf_rl<cím>=0|1`, `exf_rt<cím>=0|1`, `exf_as<cím>=0|1`,
  `exf_ts<cím>=0|1`, `exf_tp<cím>=s`; csillagos: `exf_sync*<cím>=1`, `exf_cap*<cím>=1`, `exf_view*<cím>=1`, `exf_reqid*<cím>=1`; AUX: `exa_m*<cím>*<pin>=0|1` (0-10 V / digitális ledszalag).
- Program-származtatás: bemenet `sw=(cím-1)*16+l` ↔ kimenet PCA `abs=(cím-1)*16+l` (2001+abs / 4001+abs fade), csoport csak ha minden tag helyi,
  PCA-termosztát csak ha az aktivátor (1..100) a panel 1Wire-slotja; `out_invert` = `PCA_invert` bitek; `in_press_ms` = pressTimeLimit.

Szerviz-eszköz: `tools/exp_flash.py cfg get|set …`, `bind rd|wr|clr|crc`, `save`, `id` (kiterjesztett kiírás), `sim` (failsafe-állapotgép).


## 10/H. MIA – myIO Intelligens Asszisztens, öntanuló réteg (/ai, ai.json) **[4.11+]**

Megfigyelő réteg (AI_PLAN.md): percenként olvassa a fűtés-jellegű termosztát-kötéseket
(`relay_thermoActivator` 1..100 = 1Wire eepromIndex, 300.. = univerzális szenzor; BE-küszöb < KI-küszöb)
és zónánként tanul (Arduino-független mag: `ai_core.h/.cpp`, host-teszt `bench_ai/`). Megfigyelőként **nem ír kimenetre.**
Mester-kapcsoló (`en`) + funkció-bitek (`feat`: 1 zóna-hőmodell, 2 ablaknyitás; **[4.12+]** 4 előfűtés, 32 fűtés-szünet —
beavatkozók, alapból KI; 8/16 fenntartva).

**`GET /ai.json`** *(editor/admin)*:
```json
{"en":1,"feat":39,"wd":50,"wm":5,"wh":30,"pm":120,"pd":3,"rdus":4210,"nx":360,"nxs":1,"zmax":16,
 "zones":[{"r":5,"s":17,"t":1820,"on":0,"hr":176,"cr":-79,"lag":8,"ov":31,"us":10,"duty":30,"cy":16,"conf":100,"we":0,"win":0,"mpd":34,
           "ps":1,"pt":360,"pg":2100,"pa":262,"pk":91,"pe":-2,"pc":7,"hold":0,"xa":0,"pn":7,"pw":0,"ww":0}]}
```
- `r` relé-ID, `s` forrás (1..100 1Wire eepromIndex | 300+idx uSensor), `t` °C×100 (−32768 = nincs érvényes érték),
  `on` relé-állapot, `hr`/`cr` felfűtési/hűlési sebesség °C/h×100 (EMA α = 1/8; a holt idő utáni szakaszból),
  `lag` holt idő perc (BE után ennyi, míg emelkedni kezd), `ov`/`us` túllövés/alálendülés °C×100,
  `duty` 24 h kitöltés %, `cy` lezárt BE-fázisok, `conf` 0..100 % (~8 fűtés + 8 hűlés minta), `we` ablaknyitások száma,
  `win` 1 = most „ablak nyitva?”, `mpd` perc / 1 °C (= 6000/hr).
- **[4.12+]** globál: `pm`/`pd` (előfűtés-plafon perc / napi max.), `rdus` az utolsó cél-slot olvasás ideje (µs),
  `nx` a legközelebbi relays.xml-betöltés az időzítőben (nap-perc, −1 = ma nincs több), `nxs` annak slotja.
  Zónánként (a tömb VÉGÉN — a régi kliens az első 15 mezőt olvassa): `ps` előfűtés-állapot (0 nincs terv, 1 terv,
  2 fut = MIA tartja a relét, 3 átadva, a cél-időpontig mér), `pt` a váltás ideje (nap-perc, −1), `pg` célhőfok = a cél-slot
  BE-küszöbe (°C×100), `pa` becsült / tényleges indítás (nap-perc, −1; `pa == pt` = nem kell), `pk` tanult korrekció ×100
  (50..250), `pe` utolsó eredmény perc (negatív = korábban érte el; −32768 = nincs), `pc` előfűtések száma, `hold`
  0 / 1 előfűtés / 2 fűtés-szünet, `xa` 1 = a zóna kizárva, `pn` eredmény-minták, `pw`/`ww` az utolsó megszakítás /
  szünet-vége oka (0 rendben/zárás, 1 bit KI, 2 ablak, 3 kézi kapcsolás, 4 hőmérő-kiesés, 5 fagyvédelem, 6 időtúllépés).
- Web var-blokk (`/ai`): `ai_en, ai_feat, ai_wd, ai_wm, ai_wh, ai_zmax, ai_z=[[r,s,t,on,hr,cr,lag,ov,us,duty,cy,conf,we,win,mpd],…]`
  + **[4.12+]** `ai_pm, ai_pd, ai_rdus, ai_nx, ai_nxs`, a zóna-tömb a fenti 12 mezővel bővül (`…,mpd,ps,pt,pg,pa,pk,pe,pc,hold,xa,pn,pw,ww`)
  + **[4.13+]** `ai_f3` (jelenlét-kapu), a zóna-tömb további 9 mezője: `lo` / `ln` előre-idő KI / BE (perc),
  `ob` / `ub` túllövés / alálendülés „előtte” (×100; 0 = nincs pillanatkép), `mo` / `mf` min. BE / KI (perc, 0 = auto),
  `xt` kizárva, `f3` állapot (0 bit KI, 1 él, 2 kizárva [xa/xt/késleltetett relé], 3 várakozik [conf < 50 %]), `fc` előre-kapcsolások
  + `relay_description`, `thermo_description`, `usens_description` (nevek).
- POST (ld. 4.): `ai_en`, `ai_feat`, `ai_wd`, `ai_wm`, `ai_wh`, `ai_reset`; **[4.12+]** `ai_pm`, `ai_pd`, `ai_xa`; **[4.13+]** `ai_xt`, `ai_mo*<relé>`, `ai_mf*<relé>`.
- evlog **[4.13+]**: `System,AI,TPI,R<n>,off|on,<T ×100>,<becsült elmozdulás ×100>,<előre-idő perc>` minden előre-kapcsolásnál.
- ai.jsn **[4.13+]** zóna-kulcsok: `lo,ln` (előre-idő ×16), `nlo,nln`, `ob,ub,fb` („előtte” + pillanatkép-flag), `fc`, `mo,mf`, `xt`.
- evlog: `System,AI,WIN,R<n>,open|close`; navbar **M68** (óránként legfeljebb egyszer).
  **[4.12+]** `System,AI,PRE,R<n>,start,<előfutás perc>,<T×100>,<cél×100>,<óó:pp>` / `…,done,<eltérés perc>,<T a célban×100>,<k×100>` /
  `…,abort,<win|ovr|sens|bit|timeout>`; `System,AI,WACT,R<n>,hold` / `…,release,<close|frost|ovr|sens|bit>`;
  navbar **M69** (előfűtés indult) / **M70** (fűtés-szünet), óránként legfeljebb egy-egy.
- Fájl: `ai.jsn` (root; SD → QSPI) `{"ai":{"v":1,"en","feat","wd","wm","wh","pm","pd","z":[{"r","s","hr","cr","lag"(perc×16),"ov","us","cy","nh","nc","nl","no","nu","we","pk","pn","pc","pe","xa"}]}}`
  (a `pm…xa` mezők 4.12+; hiányuk = alapérték, a régi fájl változtatás nélkül betöltődik);
  mentés konfig-változáskor azonnal, a tanult állapot legfeljebb 6 óránként / éjfélkor, ha változott. Más hőmérő ugyanazon a relén
  → a zóna tanult állapota törlődik (más fizika); megszűnt kötés → a zóna eltűnik.
- Soros: `?ai.` állapot-dump.
- Ablaknyitás: az utolsó `wm` perc esése ≥ `wd` ÉS (ha már van tanult hűlés) ≥ 3× a tanult hűlési sebesség; zárás +0,2 °C
  visszaépülésre vagy `wh` perc után. Nyitás alatt a fázisból nem tanul (szennyezett).
- Nem tanul: csonka (boot utáni) fázisból, 12 óránál hosszabb fázisból, 60 percnél hosszabb holt időből, érvénytelen mintából
  (szenzorhiba, −20..+60 °C-on kívül, >5 °C/perc ugrás).
- **Előfűtés [4.12+] (AI_PLAN 5b):** a váltást a `TimerCheck` végén egy passzív peek látja (a mai függő relays.xml-betöltések:
  timer event 1 = load all, 12 = relays.xml; percenként az utolsó betöltés-típus számít, mint a `load` változónál); a cél-slot
  `slot_N/relays.xml`-jét csak akkor olvassa (külön loop-menetben), ha a betöltés `pm`+30 percen belülre ért. Terv = azonos
  hőmérő, fűtés-jellegű, és a cél-BE ≥ a mostani BE + 0,2 °C. Indítás, ha `cél − most ≤ min((holt idő + ΔT×60/hr)×k/100, pm)`
  és: conf ≥ 50 %, nincs „nyitva?”, napi indítás < `pd`, a zóna nincs kizárva. **Termosztát-tartás:** a tartás alatt a
  `SensorActivatorChecker` a relét kihagyja, MIA `IoCmdRelayOn/Off`-fal vezérli a cél-küszöbökkel; a slot betöltésekor
  (a küszöbök = cél) átadja, legkésőbb cél + 5 perckor. Eredmény a cél-időpontban → `k` EMA (az első 4 mintánál α = 1/2,
  utána 1/4). Megszakítás: kézi/más kapcsolás (a relé eltér a kívánttól), ablak, 3 érvénytelen minta, bit KI.
- **Fűtés-szünet [4.12+]:** a WINDOW bittel együtt; „nyitva?” → tartás + KI; old: zárás, `wh`+1 perc, ≤ 8,0 °C (fagyvédelem),
  kézi kapcsolás, bit KI. Ugyanarra a nyitásra nem tart újra.
