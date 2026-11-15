# NBA Analytics — versión inicial actualizada

Proyecto Flutter para Android. Esta versión incorpora una primera base funcional para registrar pronósticos, guardar resultados reales y evaluar métricas sin modificar retroactivamente el pronóstico original.

## Incluido en esta versión
- Registro manual de pronósticos de partidos: equipos, fecha, marcador estimado, ganador, probabilidad y versión del modelo.
- Historial local persistente en el teléfono.
- Registro posterior del marcador real, separado de los datos originales del pronóstico.
- Bloqueo lógico de un segundo registro de resultado para el mismo pronóstico.
- Métricas: acierto del ganador y error medio de puntos por equipo.
- Comparación básica por versión del modelo.
- Flujo de GitHub Actions para analizar y compilar un APK de lanzamiento.

## Límites importantes
- Aún NO conecta con una API NBA, no descarga calendario/estadísticas y no genera predicciones automáticamente.
- Los datos se guardan localmente en el dispositivo mediante SharedPreferences; todavía no hay sincronización en la nube ni respaldo multi-dispositivo.
- El campo de versión identifica qué versión produjo el pronóstico; aún no existe entrenamiento automático. El aprendizaje real requiere datos históricos, validación temporal y comparación fuera de muestra.
- La inmutabilidad está protegida por la lógica de la aplicación, no por una base de datos transaccional/auditable. Antes de producción conviene migrar a backend con registros append-only y controles de integridad.

## Subir desde Android
1. Descarga y extrae el ZIP con la aplicación Archivos.
2. En GitHub crea un repositorio llamado `NBA-Analytics`.
3. Sube el CONTENIDO de la carpeta extraída, manteniendo las carpetas `lib` y `.github`. No subas el ZIP como único archivo.
4. Asegúrate de que la rama principal se llame `main`.
5. Abre la pestaña Actions del repositorio y habilita los workflows si GitHub lo solicita.
6. Espera a que termine `Build Android APK`. Si finaliza correctamente, abre la ejecución y descarga el artefacto `nba-analytics-apk`.

## Desarrollo local
Requiere Flutter estable y Android SDK:
```bash
flutter pub get
flutter analyze
flutter run
```
