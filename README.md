# Gastrotid – ordresamler til Piranya

Samler dagens bestillinger fra Wopla, Frokostfirmaet og OG til én CSV i Wopla-format, klar til indlæsning i Piranya.

## Daglig brug
1. Log ind på gastrotid.com med admin-adgangskoden.
2. Træk de tre CSV-filer ind. De genkendes automatisk.
3. Tjek leveringsdatoen for OG og eventuelle nye OG-navne.
4. Klik **Lav og hent samlet CSV** og indlæs filen i Piranya.

## Faste OG-ID'er
OG leverer hverken kunde- eller produkt-ID'er. De tildeles fra tabellen `og_id_register` i Postgres:
- kunder fra 910001, produkter fra 920001
- kendte navne får altid samme ID (store/små bogstaver og ekstra mellemrum ignoreres)
- nye navne kan få nyt ID eller kobles til et eksisterende, hvis OG har stavet et gammelt navn anderledes
- et ID må aldrig genbruges eller nummereres om

Ved første start fyldes registret med de 58 ID'er fra `db/og_register_seed.json`.

## Drift (Railway)
| Variabel | Formål |
| --- | --- |
| `DATABASE_URL` | Postgres-forbindelse (sættes af Railway) |
| `ADMIN_PASSWORD` | Adgangskode til login |
| `SESSION_SECRET` | Valgfri. Hemmelighed til login-cookien (ellers bruges ADMIN_PASSWORD) |

Start: `npm start`. Tabellerne `og_id_register`, `ordre_settings` og `ordre_log` oprettes automatisk.
