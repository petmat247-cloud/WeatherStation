# ✅ Checklist — Co zjistit doma

> Projdi postupně každý krok a výsledky napiš do chatu s AI.
> Stačí fotka / screenshot nebo prostý popis co vidíš.

---

## 📋 KROK 1 — Přesný název modelu stanice

Podívej se na **zadní stranu konzole** (displeje/základny uvnitř).
Hledáš štítek s názvem modelu — bude tam něco jako:

```
Sencor SWS XXXXX
```

**➡️ Napiš mi:** Celý název modelu ze štítku (např. "SWS 12500")

---

## 📋 KROK 2 — Jakou appku používáš

Přes co jsi nastavoval připojení na Weathercloud?

- [ ] Appka **WSLink** (v App Store / Google Play)
- [ ] Appka **WS View** nebo **WS View Plus**
- [ ] Přes webový prohlížeč v počítači
- [ ] Nevím / jinak

**➡️ Napiš mi:** Název appky a jestli ji máš v telefonu nainstalovanou

---

## 📋 KROK 3 — Otevři konfiguraci stanice (webové rozhraní)

Toto je nejdůležitější krok. Postup:

### 3a) Přepni stanici do AP módu
1. Najdi na **zadní straně konzole** tlačítko označené **`SENSOR / WI-FI`** nebo podobně
2. Drž ho **6–8 sekund** dokud nezabliká `AP` a ikonka Wi-Fi na displeji
3. Pousti tlačítko

### 3b) Připoj se na Wi-Fi stanice
1. Na telefonu (nebo počítači) vypni mobilní data ⚠️
2. Otevři nastavení Wi-Fi
3. Hledej síť s názvem **`PWS-XXXXXX`** nebo **`EasyWeather-XXXXXX`**
4. Připoj se na ni (heslo není potřeba)

### 3c) Otevři prohlížeč
Zadej adresu: **`http://192.168.1.1`**

Pokud se nic neotevře, zkus: **`http://192.168.4.1`**

### 3d) Co hledat na stránce
Projdi všechny záložky/sekce které tam vidíš a hledej:
- Záložka nebo sekce **"Weather Services"** nebo **"Server"**
- Jestli vidíš tlačítka / přepínače pro:
  - Weather Underground
  - Weathercloud  
  - **"Custom"** / **"Customized"** / **"3rd party"** ← to je co hledáme!
- Políčko **"Upload interval"** — jaké hodnoty jdou nastavit (minuty)

**➡️ Napiš mi (nebo pošli screenshot):**
- Co přesně vidíš na stránce `192.168.1.1`
- Jestli tam je nebo není možnost Custom/Customized server
- Jaký je aktuálně nastavený upload interval

---

## 📋 KROK 4 — Informace o Weathercloud účtu

Na webu [weathercloud.net](https://weathercloud.net) po přihlášení:

1. Jdi do nastavení své stanice
2. Hledej **Device ID** nebo **Station ID** (bude to kombinace čísel a písmen)
3. Hledej **Key** nebo **Password** stanice (ne tvoje heslo k účtu, ale klíč stanice)

**➡️ Napiš mi:**
- Device ID stanice (např. `abc123456`)
- Zda vidíš nějaký API klíč nebo token stanice

> ⚠️ Tato čísla jsou jen identifikátory, ne hesla k účtu — klidně je sdílej.

---

## 📋 KROK 5 — Bonusové info (pokud to jde zjistit)

Nepovinné, ale hodí se:

- [ ] Jaký router máš doma? (výrobce/model — např. "TP-Link Archer C6")
- [ ] Máš doma Raspberry Pi nebo jiné vždy zapnuté zařízení?
- [ ] Máš GitHub účet? (pokud ne, bude potřeba založit)
- [ ] Máš Cloudflare účet? (pokud ne, bude potřeba založit — je zdarma)

---

## 📸 Ideální výstup od tebe

Po projití těchto kroků mi pošli:

1. **Název modelu** ze štítku stanice
2. **Screenshot nebo popis** stránky `192.168.1.1` — hlavně záložka se serverovým nastavením
3. **Device ID** z Weathercloudu
4. Odpovědi na bonusové otázky z Kroku 5

---

## ⏭️ Co se stane potom

Jakmile budu mít tyto informace, vím:
- Jestli stanice podporuje přímý custom server (ideální varianta)
- Nebo jestli musíme použít záložní řešení přes Weathercloud
- A nastavím vše přesně pro tvůj konkrétní model

**Potom začneme psát skutečný kód.** 🚀

---

*Uloženo: září 2026*
