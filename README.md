# NBA Analytics

Aplicación Flutter para Android que combina datos NBA recopilados desde ESPN, estadísticas individuales y pronósticos automáticos experimentales con evaluación histórica.

## Funciones disponibles

- Sincronización en la nube de calendario futuro, marcadores y resultados mediante Supabase Edge Functions.
- Sincronización diaria del calendario ESPN para mantener próximos partidos disponibles para el motor de pronósticos.
- Recopilación periódica de boxscores y estadísticas de jugadores/equipos.
- Pantalla de jugadores con búsqueda, temporadas disponibles, promedios calculados sobre los partidos recopilados y detalle de partidos recientes.
- Pantalla NBA con calendario, marcadores recientes y estadísticas individuales disponibles.
- Motor experimental de pronósticos de partidos: utiliza los últimos 10 partidos finalizados de cada equipo, exige al menos 5 partidos por equipo, estima puntos anotados/permitidos y ajusta la localía.
- Probabilidades de victoria calculadas mediante una transformación logística no calibrada; deben interpretarse como estimaciones experimentales, no como probabilidades garantizadas.
- Registro local de pronósticos manuales, conservando el pronóstico original al añadir el resultado real.
- Métricas descriptivas de acierto del ganador y error medio de puntos, separadas por versión registrada.

## Estado y límites actuales

- La fuente de datos integrada es ESPN. La cobertura depende de la disponibilidad y calidad de los datos que entrega la fuente.
- Los promedios de jugadores representan únicamente los partidos que ya están guardados; no deben interpretarse como promedios completos de temporada.
- La sincronización histórica se ejecuta por lotes diarios. La cobertura histórica todavía está en proceso de ampliación.
- Los pronósticos automáticos están activos como primera versión experimental (`rolling-form-0.1`). El motor devuelve pronósticos de próximos partidos, pero todavía no guarda automáticamente cada pronóstico en las tablas de historial en la nube.
- El modelo no está calibrado y todavía no entrena ni modifica automáticamente sus parámetros. Cuando aparece el resultado final, el motor registra una evaluación inmutable por pronóstico con errores de puntos, acierto del ganador y Brier score; esta evaluación se procesa al cargar pronósticos o mediante la ejecución diaria. La pantalla de historial y las métricas agregadas por versión siguen pendientes. Las variantes nuevas deben compararse mediante backtests sin fuga de datos antes de reemplazar el modelo vigente.
- El registro local del teléfono no equivale todavía a un historial de pronósticos sincronizado y auditable en la nube.
- Las estadísticas de jugadores que no hayan superado la validación de calidad no deben utilizarse como datos de entrenamiento.

## Arquitectura

- **Android / Flutter:** interfaz, consulta del motor y registro local de pronósticos manuales.
- **Supabase:** base de datos central para calendario, equipos, jugadores, resultados y estadísticas.
- **Edge Functions:** sincronización ESPN, motor experimental de pronósticos y persistencia controlada de snapshots. Las tablas de historial conservan RLS activado y no permiten escrituras directas desde el cliente.
- **Supabase Cron:** ejecución periódica de las sincronizaciones de calendario, marcadores, boxscores y backfill histórico.
- **GitHub Actions:** análisis estático y compilación del APK cuando el workflow correspondiente se ejecuta correctamente.

La clave publishable incluida en la aplicación está diseñada para uso en clientes públicos. Nunca debe incluirse una clave secreta, una clave service_role ni credenciales de base de datos en el código Android.

## Compilar

Con Flutter estable y Android SDK instalados:

```bash
flutter pub get
flutter analyze
flutter build apk --release
```

El APK generado localmente se encuentra en:

```text
build/app/outputs/flutter-apk/app-release.apk
```

Para descargar una compilación de GitHub Actions, abre Actions, selecciona una ejecución que haya terminado correctamente y descarga el artefacto APK de esa ejecución. Comprueba la fecha y el commit de la ejecución para asegurarte de que contiene los cambios más recientes.
