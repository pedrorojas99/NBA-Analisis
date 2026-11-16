# NBA Analytics

Aplicación Flutter para Android que combina datos NBA recopilados desde ESPN, estadísticas individuales y pronósticos automáticos experimentales con evaluación histórica.

## Funciones disponibles

- Sincronización en la nube de calendario futuro, marcadores y resultados mediante Supabase Edge Functions.
- Sincronización diaria del calendario ESPN para mantener próximos partidos disponibles para el motor de pronósticos.
- Recopilación periódica de boxscores y estadísticas de jugadores/equipos.
- Pantalla de jugadores con búsqueda, temporadas disponibles, promedios calculados sobre los partidos recopilados y detalle de partidos recientes.
- Pantalla NBA con calendario, marcadores recientes y estadísticas individuales disponibles.
- Motor experimental de pronósticos por jornada: identifica la próxima fecha NBA usando el calendario de Estados Unidos (Eastern Time), espera a que todos los partidos de la jornada actual terminen y genera pronósticos solo para la siguiente fecha. Utiliza los últimos 10 partidos finalizados de cada equipo, exige al menos 5 partidos por equipo, estima puntos anotados/permitidos y ajusta la localía. Los snapshots se guardan en la nube con su versión, corte temporal y hash de las variables de entrada.
- Probabilidades de victoria calculadas mediante una transformación logística no calibrada; deben interpretarse como estimaciones experimentales, no como probabilidades garantizadas.
- Motor experimental de proyecciones individuales (`player-starter-form-0.1`) para puntos, rebotes, asistencias, triples y minutos. Combina 60% del promedio de los últimos 10 partidos y 40% del promedio de los últimos 5, y exige al menos 5 apariciones históricas con estadísticas numéricas plausibles.
- Regla obligatoria de elegibilidad: solo se pronostica un jugador cuando ESPN confirma explícitamente que es titular (`starter=true`, activo y no DNP) y entrega un informe de lesiones completo para ambos equipos sin una lesión vigente reportada para ese jugador. Si falta cualquiera de esas verificaciones, se omite el jugador; nunca se interpreta la falta de información como disponibilidad.
- Las proyecciones individuales guardan snapshots separados de los pronósticos de partido, se conservan con la versión del modelo y se evalúan frente al boxscore final de ESPN mediante errores absolutos de puntos, rebotes, asistencias, triples y minutos.
- Registro local de pronósticos manuales, conservando el pronóstico original al añadir el resultado real.
- Sección «Jornada anterior» dentro de Historial: muestra la última fecha NBA completamente evaluada con pronósticos originales, marcador final, ganador previsto/real, aciertos y errores de puntos. Solo incluye jornadas con todos los pronósticos guardados ya evaluados.
- Métricas descriptivas de acierto del ganador y error medio de puntos, separadas por versión registrada.

## Estado y límites actuales

- La fuente de datos integrada es ESPN. La cobertura depende de la disponibilidad y calidad de los datos que entrega la fuente.
- Los promedios de jugadores representan únicamente los partidos que ya están guardados; no deben interpretarse como promedios completos de temporada.
- La sincronización histórica se ejecuta por lotes diarios. La cobertura histórica todavía está en proceso de ampliación.
- Los pronósticos automáticos están activos como primera versión experimental (`rolling-form-0.1`). Cada snapshot conserva la versión del modelo y el corte temporal de sus datos; las predicciones originales no se recalculan cuando la jornada comienza.
- El motor de pronósticos de partidos y el motor de jugadores se ejecutan cada 15 minutos. Cuando existen resultados finales, registran evaluaciones inmutables: acierto del ganador, errores de puntos/margen y Brier score para partidos; errores de puntos, rebotes, asistencias, triples y minutos para jugadores. La evaluación solo ocurre después de recibir resultados finales.
- El modelo no está calibrado y todavía no entrena ni modifica automáticamente sus parámetros. Las variantes deben compararse mediante backtests walk-forward, usando únicamente partidos anteriores a cada pronóstico, antes de reemplazar el modelo vigente.
- El backtest reproducible está en `supabase/tests/nba_model_walk_forward_backtest.sql`. Compara la fórmula actual de últimos 10 partidos con una combinación 50/50 de últimos 10 y promedio histórico, además de una variante histórica. La muestra actual es limitada y está concentrada en el inicio de la temporada 2024-25; sus resultados son preliminares, no una validación suficiente para promover otro modelo.
- La prueba de estabilidad temporal está en `supabase/tests/nba_model_walk_forward_segments.sql`. Divide los partidos elegibles en tres bloques cronológicos para comprobar si una variante mantiene su rendimiento a lo largo del periodo. La ejecutamos sobre 122 partidos: la fórmula de últimos 10 logró 70.73%, 73.17% y 70.00% de acierto por bloque; el candidato 50/50 logró 70.73%, 73.17% y 72.50%. La mejora se concentra en el último bloque y sigue siendo una muestra pequeña, por lo que el modelo vigente no se cambia todavía.
- El historial automático incluye un resumen de errores por equipo para los últimos 100 pronósticos: acierto de ganador en los partidos donde participa, error absoluto de sus puntos, sesgo (sobre/subestimación), error de puntos del rival y error de margen. Se separan partidos de local y visitante. Los equipos sin pronósticos evaluados todavía no aparecen; los resultados son descriptivos y no ajustan el modelo automáticamente.
- El registro local del teléfono no equivale todavía a un historial de pronósticos sincronizado y auditable en la nube.
- Las estadísticas de jugadores que no hayan superado la validación de calidad no deben utilizarse como datos de entrenamiento.

## Arquitectura

- **Android / Flutter:** interfaz, consulta del motor y registro local de pronósticos manuales.
- **Supabase:** base de datos central para calendario, equipos, jugadores, resultados y estadísticas.
- **Edge Functions:** sincronización ESPN, motores experimentales de partidos y jugadores, verificación de titularidad/lesiones, evaluación de pronósticos y persistencia controlada de snapshots. Las tablas de historial conservan RLS activado y no permiten escrituras directas desde el cliente.
- **Supabase Cron:** ejecución periódica de sincronizaciones de calendario, marcadores, boxscores, backfill histórico y ambos motores de pronósticos.
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
