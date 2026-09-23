# __NAME__ (desarrollo)

Repositorio **privado** de desarrollo, creado y gestionado por SecureDoc.

- Tu codigo fuente va en la carpeta `src/`.
- Cada vez que subes cambios a `main` en `src/`, un flujo de GitHub Actions minifica y ofusca el codigo y lo publica en el repositorio de produccion **__PROD__** (publico, con GitHub Pages).
- Tambien puedes publicar a mano con el boton de SecureDoc (Desarrollo > Publicar).
- Configuracion en `.securedoc/config.json`: `obfuscate` en `false` publica solo minificado.

No borres `.github/workflows/securedoc-publish.yml` ni `.securedoc/`. Si los cambias por error, usa "Reinstalar flujo" en SecureDoc.

El secreto `SECUREDOC_DEPLOY_TOKEN` (Settings > Secrets and variables > Actions) lo guarda SecureDoc; si cambias tu token de GitHub, SecureDoc lo actualiza.
