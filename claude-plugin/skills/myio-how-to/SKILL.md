---
name: myio-how-to
description: Explain how to set up or use a feature of a myIO smart home controller from the official myIO documentation. Use when the user asks how to do something with myIO - blinds, heating and thermostats, timers, scenes, Flow rules, myIO Script, MQTT and Home Assistant, Homey, Matter, KNX, the myIO App - or which myIO controller supports a feature.
---

# How-to answers from the myIO documentation

The myIO documentation is in Hungarian; answer in the user's language.

1. When the question uses names you are unsure of, call `myio_about`. It maps the names used in the documentation to products (Due = myIO Server V3, GIGA = V4 GIGA, Opta = V4 Opta) and explains the version marks.
2. Search with `myio_search` in Hungarian. Translate the user's words, for example blind = `redőny`, heating = `fűtés`, thermostat = `termosztát`, timer = `időzítő`, button = `gomb`, output = `kimenet`, scene = `jelenet`. Read the best sections with `myio_read`.
3. Answer with numbered steps in the order the myIO web interface shows them, and link the source sections.
4. The manual describes the latest software, including features still in development. Before saying a product or feature is available, check the product data (source `products`): "hamarosan" means coming soon, "béta" means in beta. Version marks such as `[4.x]` tell which controllers have the feature.
5. Prices and delivery times are not in the documentation; for an offer, point to https://myio.hu/en/contact.
6. When the controller's tools are available (the user has connected their controller with the myIO Smart Home connector or with myIO MCP) and the user wants the setup applied, list the changes first and make them only after the user confirms.
