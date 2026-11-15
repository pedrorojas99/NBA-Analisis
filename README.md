# NBA Analytics

Aplicación Flutter para Android que combina datos NBA recopilados desde ESPN, consulta de estadísticas individuales y un registro verificable de pronósticos.

## Funciones disponibles

- Sincronización en la nube de calendario, marcadores y resultados mediante Supabase Edge Functions.
- Recopilación periódica de boxscores y estadísticas de jugadores/equipos.
- Pantalla de jugadores con búsqueda, temporadas disponibles, promedios calculados sobre los partidos recopilados y detalle de partidos recientes.
- Pantalla NBA con calendario, marcadores recientes y estadísticas individuales disponibles.
- Registro local de pronósticos manuales, conservando el pronóstico original al añadir el resultado real.
- Métricas descriptivas de acierto del ganador y error medio de puntos, separadas por versión registrada.

## Estado y límites actuales

- La fuente de datos integrada es ESPN. La cobertura depende de la disponibilidad y calidad de los datos que entrega la fuente.
- Los promedios de jugadores representan únicamente los partidos que ya están guardados; no deben interpretarse como promedios completos de temporada.
- La sincronización histórica se ejecuta por lotes diarios. La cobertura histórica todavía está en proceso de ampliación.
- Los pronósticos siguen siendo manuales y se guardan localmente en el teléfono. La aplicación todavía no genera pronósticos automáticos.
- La sección de aprendizaje calcula métricas de evaluación, pero todavía no entrena ni modifica automáticamente un modelo.
- El registro local del teléfono no equivale todavía a un historial de pronósticos sincronizado y auditable en la nube.

## Arquitectura

- **Android / Flutter:** interfaz y registro local de pronósticos.
- **Supabase:** base de datos central para partidos, equipos, jugadores, resultados y estadísticas.
- **Edge Functions:** sincronización de datos ESPN y API pública de solo lectura para la aplicación.
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
