import 'dart:async';
import 'package:flutter/material.dart';
import '../services/nba_data_service.dart';
import '../models/prediction.dart';
import '../services/prediction_store.dart';
import '../services/nba_prediction_service.dart';
import '../services/nba_prediction_history_service.dart';
import '../services/nba_player_prediction_service.dart';
import 'search_hub_screen.dart';
import 'matchup_prediction_card.dart';
import 'game_analysis_screen.dart';
import '../services/app_update_service.dart';

class _NbaAnalyticsLogo extends StatelessWidget {
  final double size;
  const _NbaAnalyticsLogo({required this.size});

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: Size(size, size),
    painter: _BasketballLogoPainter(),
  );
}

class _BasketballLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.shortestSide * 0.46;
    final ball = Paint()..color = const Color(0xFFE8752E);
    final seam = Paint()..color = const Color(0xFF241D1A)..style = PaintingStyle.stroke..strokeWidth = size.shortestSide * 0.045..strokeCap = StrokeCap.round;
    canvas.drawCircle(center, radius, ball);
    canvas.drawCircle(center, radius, seam);
    final lines = Path()
      ..moveTo(center.dx - radius, center.dy)..lineTo(center.dx + radius, center.dy)
      ..moveTo(center.dx, center.dy - radius)..lineTo(center.dx, center.dy + radius)
      ..moveTo(center.dx - radius * .72, center.dy - radius * .68)
      ..cubicTo(center.dx - radius * .08, center.dy - radius * .25, center.dx - radius * .08, center.dy + radius * .25, center.dx - radius * .72, center.dy + radius * .68)
      ..moveTo(center.dx + radius * .72, center.dy - radius * .68)
      ..cubicTo(center.dx + radius * .08, center.dy - radius * .25, center.dx + radius * .08, center.dy + radius * .25, center.dx + radius * .72, center.dy + radius * .68);
    canvas.save();
    canvas.clipPath(Path()..addOval(Rect.fromCircle(center: center, radius: radius)));
    canvas.drawPath(lines, seam);
    canvas.restore();
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
class HomeScreen extends StatefulWidget {
  final int themeIndex;
  final ValueChanged<int> onThemeChanged;
  const HomeScreen({super.key, this.themeIndex = 0, this.onThemeChanged = _ignoreThemeChange});

  static void _ignoreThemeChange(int value) {}
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final store = PredictionStore();
  final nbaService = NbaDataService();
  final predictionService = NbaPredictionService();
  final historyService = NbaPredictionHistoryService();
  final playerPredictionService = NbaPlayerPredictionService();
  final appUpdateService = AppUpdateService();
  int tab = 0;
  List<NbaGame> nbaGames = [];
  bool nbaLoading = true;
  String? nbaError;
  DateTime? nbaUpdatedAt;
  Map<String, dynamic> nbaMeta = {};
  List<NbaPlayerGameStat> nbaPlayerStats = [];
  List<NbaForecast> nbaForecasts = [];
  Map<String, dynamic> predictionMeta = {};
  bool predictionLoading = true;
  String? predictionError;
  String predictionModelVersion = 'rolling-form-0.1';
  List<NbaPlayerForecast> playerForecasts = [];
  Map<String, dynamic> playerPredictionMeta = {};
  bool playerPredictionLoading = true;
  String? playerPredictionError;
  List<NbaStoredPrediction> cloudPredictions = [];
  List<NbaStoredPlayerPrediction> cloudPlayerPredictions = [];
  bool cloudHistoryLoading = true;
  String? cloudHistoryError;
  int cloudEvaluatedCount = 0;
  int cloudPendingCount = 0;
  List<NbaTeamErrorSummary> cloudTeamAnalysis = [];
  String? cloudPreviousSlateDate;
  List<NbaStoredPrediction> cloudPreviousSlateGames = [];
  int cloudPreviousSlateWinnerCorrect = 0;
  double? cloudPreviousSlateWinnerAccuracyPct;
  double? cloudPreviousSlateAverageScoreError;
  double? cloudPreviousSlateAverageMarginError;
  List<Prediction> predictions = [];
  bool loading = true;
  bool showPreviousResults = false;
  Timer? _liveScoreTimer;
  bool _liveScoreRefreshInFlight = false;

  @override
  void initState() {
    super.initState();
    refresh();
    refreshNbaData();
    refreshPredictions();
    refreshPlayerPredictions();
    _liveScoreTimer = Timer.periodic(const Duration(seconds: 3), (_) => _refreshLiveScores());
  }

  Future<void> _refreshLiveScores() async {
    if (!mounted || tab != 0 || _liveScoreRefreshInFlight) return;
    _liveScoreRefreshInFlight = true;
    try {
      final data = await nbaService.loadLiveScores();
      if (!mounted) return;
      setState(() {
        nbaGames = data.games;
        nbaUpdatedAt = data.updatedAt;
        nbaMeta = data.meta;
      });
    } catch (_) {
      // Keep the last confirmed scoreboard visible if a short poll fails.
    } finally {
      _liveScoreRefreshInFlight = false;
    }
  }

  @override
  void dispose() {
    _liveScoreTimer?.cancel();
    super.dispose();
  }

  Future<void> _checkForAppUpdate() async {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Buscando actualizaciones…')),
    );
    bool progressDialogOpen = false;
    StateSetter? updateProgressDialog;
    double? downloadProgress;
    var receivedBytes = 0;
    var totalBytes = 0;

    String formatBytes(int bytes) =>
        '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';

    try {
      final update = await appUpdateService.checkForUpdate();
      if (!mounted) return;
      if (update == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Ya tienes la última versión de NBA Analytics.')),
        );
        return;
      }
      final install = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Nueva versión disponible'),
          content: Text('Hay una actualización (build ${update.buildNumber}). ¿Quieres descargarla e instalarla ahora?'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Después')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Actualizar')),
          ],
        ),
      );
      if (install != true || !mounted) return;

      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, setDialogState) {
            updateProgressDialog = setDialogState;
            final percent = downloadProgress == null
                ? null
                : (downloadProgress! * 100).round();
            return AlertDialog(
              title: Text('Descargando NBA Analytics · build ${update.buildNumber}'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  LinearProgressIndicator(value: downloadProgress),
                  const SizedBox(height: 12),
                  Text(percent == null ? 'Descargando…' : '$percent %'),
                  const SizedBox(height: 4),
                  Text(
                    totalBytes > 0
                        ? '${formatBytes(receivedBytes)} de ${formatBytes(totalBytes)}'
                        : '${formatBytes(receivedBytes)} descargados',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'No cierres la aplicación. Al terminar se abrirá el instalador de Android.',
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ),
            );
          },
        ),
      );
      progressDialogOpen = true;

      await appUpdateService.downloadAndInstall(
        update,
        onProgress: (progress, received, total) {
          if (!mounted || !progressDialogOpen) return;
          updateProgressDialog?.call(() {
            downloadProgress = progress;
            receivedBytes = received;
            totalBytes = total;
          });
        },
      );

      if (mounted && progressDialogOpen) {
        progressDialogOpen = false;
        Navigator.of(context, rootNavigator: true).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Descarga completada. Confirma la instalación en Android.')),
        );
      }
    } catch (error) {
      if (!mounted) return;
      if (progressDialogOpen) {
        progressDialogOpen = false;
        Navigator.of(context, rootNavigator: true).pop();
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('No se pudo actualizar: $error')),
      );
    }
  }

  Future<void> refresh() async {
    final data = await store.load();
    if (!mounted) return;
    setState(() { predictions = data; loading = false; });
  }

  Future<void> refreshPredictions() async {
    if (mounted) setState(() { predictionLoading = true; predictionError = null; });
    try {
      final data = await predictionService.load();
      if (!mounted) return;
      setState(() {
        nbaForecasts = data.forecasts;
        predictionMeta = data.meta;
        predictionModelVersion = data.modelVersion;
        predictionLoading = false;
      });
      await refreshCloudHistory();
    } catch (e) {
      if (!mounted) return;
      setState(() { predictionError = e.toString(); predictionLoading = false; });
    }
  }

  Future<void> refreshPlayerPredictions() async {
    if (mounted) setState(() { playerPredictionLoading = true; playerPredictionError = null; });
    try {
      final data = await playerPredictionService.load();
      if (!mounted) return;
      setState(() {
        playerForecasts = data.forecasts;
        playerPredictionMeta = data.meta;
        playerPredictionLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { playerPredictionError = e.toString(); playerPredictionLoading = false; });
    }
  }

  Future<void> refreshCloudHistory() async {
    if (mounted) setState(() { cloudHistoryLoading = true; cloudHistoryError = null; });
    try {
      final data = await historyService.load();
      if (!mounted) return;
      setState(() {
        cloudPredictions = data.forecasts;
        cloudPlayerPredictions = data.playerForecasts;
        cloudEvaluatedCount = data.evaluatedCount;
        cloudPendingCount = data.pendingCount;
        cloudTeamAnalysis = data.teamAnalysis;
        cloudPreviousSlateDate = data.previousSlateDate;
        cloudPreviousSlateGames = data.previousSlateGames;
        cloudPreviousSlateWinnerCorrect = data.previousSlateWinnerCorrect;
        cloudPreviousSlateWinnerAccuracyPct = data.previousSlateWinnerAccuracyPct;
        cloudPreviousSlateAverageScoreError = data.previousSlateAverageScoreError;
        cloudPreviousSlateAverageMarginError = data.previousSlateAverageMarginError;
        cloudHistoryLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { cloudHistoryError = e.toString(); cloudHistoryLoading = false; });
    }
  }

  Future<void> refreshNbaData() async {
    if (mounted) setState(() { nbaLoading = true; nbaError = null; });
    try {
      final data = await nbaService.load();
      if (!mounted) return;
      setState(() {
        nbaGames = data.games;
        nbaUpdatedAt = data.updatedAt;
        nbaMeta = data.meta;
        nbaPlayerStats = data.playerStats;
        nbaLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { nbaError = e.toString(); nbaLoading = false; });
    }
  }

  Future<void> addPrediction() async {
    final result = await showDialog<Prediction>(
      context: context, builder: (_) => const PredictionDialog(),
    );
    if (result == null) return;
    await store.add(result);
    await refresh();
  }

  Future<void> addActual(Prediction p) async {
    final result = await showDialog<(int, int)>(
      context: context, builder: (_) => ActualResultDialog(prediction: p),
    );
    if (result == null) return;
    try {
      await store.recordActual(p.id, result.$1, result.$2);
      await refresh();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      _liveNbaPage(), const SearchHubScreen(), _gamesPage(), _historyPage(), _learningPage(),
    ];
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 68,
        title: Row(mainAxisSize: MainAxisSize.min, children: [
          const _NbaAnalyticsLogo(size: 43),
          const SizedBox(width: 9),
          const Text('NBA ANALYTICS', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1, fontSize: 21, color: Color(0xFFB94D2B))),
        ]),
        actions: [
          IconButton(
            onPressed: () { refresh(); refreshNbaData(); refreshPredictions(); refreshPlayerPredictions(); },
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: 'Actualizar datos',
          ),
          PopupMenuButton<String>(
            tooltip: 'Menú',
            onSelected: (value) {
              if (value == 'app_update') _checkForAppUpdate();
              if (value.startsWith('theme_')) {
                final selected = int.tryParse(value.substring(6));
                if (selected != null) widget.onThemeChanged(selected);
              }
            },
            itemBuilder: (context) => [
              const PopupMenuItem(
                value: 'app_update',
                child: Row(children: [
                  Icon(Icons.system_update_alt),
                  SizedBox(width: 10),
                  Text('Actualizar APK'),
                ]),
              ),
              const PopupMenuDivider(),
              const PopupMenuItem(
                value: 'theme_0',
                child: Row(children: [Icon(Icons.palette_outlined), SizedBox(width: 10), Text('Tema actual · Azul claro')]),
              ),
              const PopupMenuItem(
                value: 'theme_1',
                child: Row(children: [Icon(Icons.wb_sunny_outlined), SizedBox(width: 10), Text('Tema cálido · Crema')]),
              ),
              const PopupMenuItem(
                value: 'theme_2',
                child: Row(children: [Icon(Icons.nightlight_round), SizedBox(width: 10), Text('Tema cálido · Atardecer')]),
              ),
            ],
          ),
        ],
      ),
      body: loading ? const Center(child: CircularProgressIndicator()) : pages[tab],
      floatingActionButton: null,
      bottomNavigationBar: NavigationBar(
        height: 72,
        selectedIndex: tab,
        onDestinationSelected: (v) => setState(() => tab = v),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.sports_basketball), label: 'NBA'),
          NavigationDestination(icon: Icon(Icons.search), label: 'Buscar'),
          NavigationDestination(icon: Icon(Icons.sports_basketball_outlined), label: 'Predicciones'),
          NavigationDestination(icon: Icon(Icons.history), label: 'Historial'),
          NavigationDestination(icon: Icon(Icons.menu_book), label: 'Aprendizaje'),
        ],
      ),
    );
  }

  DateTime _localSlateDay(DateTime value) {
    final local = value.toLocal();
    return DateTime(local.year, local.month, local.day);
  }


  Map<DateTime, List<NbaGame>> get _gamesByLocalDate {
    final grouped = <DateTime, List<NbaGame>>{};
    for (final game in nbaGames) {
      grouped.putIfAbsent(_localSlateDay(game.scheduledStart), () => []).add(game);
    }
    for (final games in grouped.values) {
      games.sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
    }
    return grouped;
  }

  DateTime? get _latestCompletedSlateDate {
    final completed = _gamesByLocalDate.entries
        .where((entry) => entry.value.isNotEmpty &&
            entry.value.every((game) => game.status == 'final'))
        .map((entry) => entry.key)
        .toList()
      ..sort((a, b) => b.compareTo(a));
    return completed.isEmpty ? null : completed.first;
  }

  List<NbaGame> get _latestCompletedSlateGames {
    final date = _latestCompletedSlateDate;
    return date == null ? const [] : (_gamesByLocalDate[date] ?? const []);
  }

  DateTime? get _nextSlateDate {
    final dates = _gamesByLocalDate.entries
        .where((entry) => entry.value.any((game) => game.status != 'final'))
        .map((entry) => entry.key)
        .toList()
      ..sort();
    return dates.isEmpty ? null : dates.first;
  }

  List<NbaGame> get _nextSlateGames {
    final date = _nextSlateDate;
    return date == null ? const [] : (_gamesByLocalDate[date] ?? const []);
  }

  Widget _liveNbaPage() => RefreshIndicator(
    onRefresh: () async {
      await Future.wait([
        refreshNbaData(),
        refreshPredictions(),
        refreshPlayerPredictions(),
      ]);
    },
    child: ListView(padding: const EdgeInsets.all(14), children: [
      Container(margin: const EdgeInsets.only(bottom: 12), padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: const Color(0xFFFFF0E5), borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFE8C9B8))),
        child: Row(children: [const _NbaAnalyticsLogo(size: 50), const SizedBox(width: 12),
          const Expanded(child: Text('PARTIDOS DE LA JORNADA', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w900, color: Color(0xFF4A2D22)))),
          IconButton(onPressed: refreshNbaData, icon: const Icon(Icons.settings, color: Color(0xFF4A2D22))),
        ])),
      OutlinedButton.icon(onPressed: () => setState(() => showPreviousResults = !showPreviousResults), icon: const Icon(Icons.history),
        label: Text(showPreviousResults ? 'OCULTAR RESULTADOS ANTERIORES' : 'RESULTADOS DE LA JORNADA ANTERIOR'),
        style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF9E3F20), backgroundColor: const Color(0xFFFFE4D2), side: const BorderSide(color: Color(0xFFD87943)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)))),
      if (showPreviousResults) ...[_section('Resultados de la jornada anterior'),
        if (_latestCompletedSlateGames.isEmpty) _empty('Todavía no hay una jornada completamente finalizada en los datos recientes.') else ..._latestCompletedSlateGames.map(_nbaGameCard)],
      if (nbaLoading) const Padding(
        padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()),
      ),
      if (nbaError != null) Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Text('No se pudo conectar: ' + nbaError!, style: const TextStyle(color: Colors.orangeAccent)),
      )),
      if (!nbaLoading && nbaGames.isEmpty && nbaError == null)
        _empty('No hay partidos en la ventana actual. Vuelve a actualizar más tarde.'),

      _section('Jornada actual'),
      if (_nextSlateGames.isEmpty)
        _empty('No hay partidos programados en la próxima jornada.')
      else
        ..._nextSlateGames.map(_nbaGameCard),
      const SizedBox(height: 12),
      const SizedBox(height: 8),
      _section('Estadísticas individuales recientes'),
      if (nbaPlayerStats.isEmpty && !nbaLoading)
        _empty('Todavía no hay estadísticas individuales para los partidos recientes. Se mostrarán cuando ESPN y la sincronización las registren.'),
      ...nbaPlayerStats.take(20).map((p) => Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ListTile(
          title: Text(p.playerName, style: const TextStyle(fontWeight: FontWeight.bold)),
          subtitle: Text('${p.teamAbbreviation} · ${p.gameDate.toLocal().toString().substring(0, 10)}'
              ' · 3PT: ${p.value('3PT')}'),
          trailing: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('${p.value('PTS')} PTS', style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
              Text('${p.value('REB')} REB · ${p.value('AST')} AST',
                  style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
        ),
      )),

    ]),
  );

  Widget _predictionSection() {
    final slateStatus = (predictionMeta['slate_status'] ?? 'unknown').toString();
    final slateDate = (predictionMeta['slate_date'] ?? '—').toString();
    final slateGames = predictionMeta['slate_games'] ?? 0;
    final slateMessage = slateStatus == 'in_progress'
        ? 'Jornada $slateDate en curso: esperamos a que termine antes de preparar la siguiente.'
        : slateStatus == 'ready'
            ? 'Próxima jornada: $slateDate · $slateGames partidos.'
            : 'No hay una próxima jornada disponible en el calendario sincronizado.';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _section('Predicciones de la próxima jornada'),
      Card(child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(slateStatus == 'in_progress' ? Icons.hourglass_top : Icons.calendar_today,
            color: const Color(0xFF1769AA)),
          const SizedBox(width: 10),
          Expanded(child: Text(slateMessage)),
        ]),
      )),
      if (predictionLoading) const Padding(
        padding: EdgeInsets.all(18), child: Center(child: CircularProgressIndicator()),
      ),
      if (predictionError != null) Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Text('No se pudieron generar predicciones: $predictionError'),
        ),
      ),
      if (!predictionLoading && predictionError == null && nbaForecasts.isEmpty)
        _empty(slateStatus == 'in_progress'
          ? 'No se generan pronósticos nuevos mientras la jornada actual siga abierta.'
          : 'No hay partidos elegibles con suficiente historial para esta próxima jornada.'),
      ...nbaForecasts.map((forecast) {
        NbaGame? game;
        for (final item in nbaGames) {
          if (item.id == forecast.gameId) { game = item; break; }
        }
        final players = playerForecasts.where((p) => p.gameId == forecast.gameId).toList();
        return MatchupPredictionCard(
          key: ValueKey(forecast.gameId),
          forecast: forecast,
          homeTeam: game?.homeTeam,
          awayTeam: game?.awayTeam,
          players: players,
          showHeadToHead: true,
        );
      }),
      if (playerPredictionLoading)
        const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator())),
      if (playerPredictionError != null)
        Padding(padding: const EdgeInsets.only(top: 6), child: Text('Datos individuales: $playerPredictionError', style: const TextStyle(fontSize: 11))),
      if (!playerPredictionLoading && playerForecasts.isEmpty)
        const Padding(padding: EdgeInsets.only(top: 6), child: Text('Aún no hay titulares confirmados o historial suficiente para generar proyecciones individuales.', style: TextStyle(fontSize: 11))),
    ]);
  }

  void _openGameAnalysis(NbaGame game) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => GameAnalysisScreen(game: game),
    ));
  }

  Widget _nbaGameCard(NbaGame game) {
    final away = game.awayTeam;
    final home = game.homeTeam;
    final isFinal = game.status == 'final';
    final isLive = game.status == 'in_progress';
    final isPending = !isFinal && !isLive;
    final statusLabel = isFinal ? 'FINAL' : (isLive ? 'EN JUEGO' : 'PENDIENTE');
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: (isPending || isFinal || isLive) ? () => _openGameAnalysis(game) : null,
        child: Padding(padding: const EdgeInsets.all(12), child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text('Hora · ' + game.scheduledStart.toLocal().toString().substring(11, 16),
                  style: Theme.of(context).textTheme.bodySmall),
              if (isPending || isFinal || isLive)
                TextButton.icon(
                  onPressed: () => _openGameAnalysis(game),
                  icon: const Icon(Icons.analytics_outlined, size: 16),
                  label: Text(isFinal ? 'VER ESTADÍSTICAS' : isLive ? 'ESTADÍSTICAS EN VIVO' : 'ANALIZAR', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                )
              else
                Text(statusLabel, style: TextStyle(
                  fontWeight: FontWeight.bold, fontSize: 11,
                  color: isLive ? const Color(0xFF16845B) : const Color(0xFF1769AA),
                )),
            ]),
            const SizedBox(height: 10),
            _teamScoreRow(away?.abbreviation ?? 'VIS', away?.name ?? 'Visitante', game.awayScore),
            const SizedBox(height: 6),
            _teamScoreRow(home?.abbreviation ?? 'LOC', home?.name ?? 'Local', game.homeScore),
            if (game.statusDetail != null && game.statusDetail!.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(game.statusDetail!, style: Theme.of(context).textTheme.bodySmall),
            ],
          ],
        )),
      ),
    );
  }

  Widget _teamScoreRow(String abbreviation, String name, int? score) => Row(
    children: [
      Image.network(
        'https://a.espncdn.com/i/teamlogos/nba/500/${({'GSW': 'gs', 'NY': 'ny', 'NO': 'no', 'SA': 'sa', 'UTAH': 'utah'}[abbreviation.toUpperCase()] ?? abbreviation.toLowerCase())}.png',
        width: 28, height: 28, fit: BoxFit.contain,
        errorBuilder: (_, __, ___) => const Icon(Icons.sports_basketball, size: 22, color: Color(0xFFEF6C35)),
      ),
      const SizedBox(width: 10),
      SizedBox(width: 48, child: Text(abbreviation, style: const TextStyle(fontWeight: FontWeight.w900))),
      Expanded(child: Text(name)),
      Text(score?.toString() ?? '—', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
    ],
  );

  Widget _totalScoreDistributionBar() {
    final evaluated = cloudPredictions.where((p) {
      final away = p.actual?['away_score'];
      final home = p.actual?['home_score'];
      return p.isEvaluated && away is num && home is num;
    }).toList();
    if (evaluated.isEmpty) {
      return Card(margin: const EdgeInsets.only(bottom: 12), child: Padding(
        padding: const EdgeInsets.all(12), child: Row(children: [
          const Icon(Icons.insights, color: Color(0xFF1769AA), size: 18),
          const SizedBox(width: 8),
          const Expanded(child: Text('Marcador total · resultados evaluados', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12))),
          Text('—', style: Theme.of(context).textTheme.titleMedium),
        ]),
      ));
    }
    var above = 0; var exact = 0; var below = 0;
    for (final p in evaluated) {
      final actualTotal = (p.actual!['away_score'] as num).toDouble() + (p.actual!['home_score'] as num).toDouble();
      final predictedTotal = (p.predictedAwayScore + p.predictedHomeScore).roundToDouble();
      if (actualTotal > predictedTotal) { above++; }
      else if (actualTotal < predictedTotal) { below++; }
      else { exact++; }
    }
    final count = evaluated.length;
    final abovePct = above * 100 / count; final exactPct = exact * 100 / count; final belowPct = below * 100 / count;
    const blue = Color(0xFF2388D1); const dark = Color(0xFF252B33); const orange = Color(0xFFEF8A32);
    Widget legend(Color color, String label, double value) => Expanded(child: Row(mainAxisSize: MainAxisSize.min, children: [
      Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
      const SizedBox(width: 4),
      Flexible(child: Text('$label ${value.toStringAsFixed(0)}%', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w600))),
    ]));
    return Card(margin: const EdgeInsets.only(bottom: 12), child: Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: Text('Marcador total · resultados evaluados', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12))),
          Text('$count partidos', style: const TextStyle(fontSize: 10, color: Color(0xFF718096))),
        ]),
        const SizedBox(height: 9),
        ClipRRect(borderRadius: BorderRadius.circular(8), child: SizedBox(height: 9, child: Row(children: [
          if (above > 0) Expanded(flex: above, child: Container(color: blue)),
          if (exact > 0) Expanded(flex: exact, child: Container(color: dark)),
          if (below > 0) Expanded(flex: below, child: Container(color: orange)),
        ]))),
        const SizedBox(height: 8),
        Row(children: [legend(blue, 'Por encima', abovePct), legend(dark, 'Exacto', exactPct), legend(orange, 'Por debajo', belowPct)]),
      ]),
    ));
  }
  Widget _gamesPage() => RefreshIndicator(
    onRefresh: () async {
      await Future.wait([
        refreshNbaData(),
        refreshPredictions(),
        refreshPlayerPredictions(),
      ]);
    },
    child: ListView(padding: const EdgeInsets.all(16), children: [
      _section('Pronósticos automáticos'),
      _totalScoreDistributionBar(),
      _predictionSection(),
      const SizedBox(height: 12),
    ]),
  );

  Widget _previousSlateSection() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _section('Jornada anterior'),
      const Text('Comparación de los partidos de la última jornada NBA completamente terminada para la que guardamos pronósticos. El marcador previsto se conserva tal como se calculó antes del inicio.'),
      const SizedBox(height: 12),
      if (cloudHistoryLoading)
        const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator())),
      if (cloudHistoryError != null)
        _empty('No se pudo cargar la comparación: $cloudHistoryError'),
      if (!cloudHistoryLoading && cloudHistoryError == null && cloudPreviousSlateGames.isEmpty)
        _empty('Todavía no hay una jornada anterior completamente evaluada. Cuando termine una jornada con pronósticos guardados, aparecerán aquí automáticamente.'),
      if (cloudPreviousSlateGames.isNotEmpty) ...[
        Card(child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('JORNADA NBA · ${cloudPreviousSlateDate ?? "—"}',
              style: const TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: _metric('Partidos', '${cloudPreviousSlateGames.length}')),
              const SizedBox(width: 8),
              Expanded(child: _metric('Ganadores acertados',
                '${cloudPreviousSlateWinnerCorrect}/${cloudPreviousSlateGames.length}')),
            ]),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: _metric('Precisión',
                cloudPreviousSlateWinnerAccuracyPct == null ? '—' : '${cloudPreviousSlateWinnerAccuracyPct!.toStringAsFixed(1)}%')),
              const SizedBox(width: 8),
              Expanded(child: _metric('Error medio marcador',
                cloudPreviousSlateAverageScoreError == null ? '—' : '${cloudPreviousSlateAverageScoreError!.toStringAsFixed(1)} pts')),
            ]),
            if (cloudPreviousSlateAverageMarginError != null)
              Text('Error medio del margen: ${cloudPreviousSlateAverageMarginError!.toStringAsFixed(1)} puntos',
                style: Theme.of(context).textTheme.bodySmall),
          ]),
        )),
        const SizedBox(height: 8),
        ...cloudPreviousSlateGames.map(_previousSlateGameCard),
      ],
      const SizedBox(height: 10),
    ],
  );

  Widget _previousSlateGameCard(NbaStoredPrediction p) {
    final actualAway = (p.actual?['away_score'] as num?)?.toDouble();
    final actualHome = (p.actual?['home_score'] as num?)?.toDouble();
    final actualWinner = actualAway == null || actualHome == null
        ? '—' : (actualAway > actualHome ? p.awayTeam : p.homeTeam);
    final winnerCorrect = p.errorMetrics?['winner_correct'] == true;
    final homeError = (p.errorMetrics?['home_score_abs_error'] as num?)?.toDouble();
    final awayError = (p.errorMetrics?['away_score_abs_error'] as num?)?.toDouble();
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(p.scheduledStart == null ? 'Fecha no disponible' : p.scheduledStart!.toLocal().toString().substring(0, 16),
            style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 6),
          Text('${p.awayTeam} vs ${p.homeTeam}',
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const Divider(),
          const Text('PRONÓSTICO ORIGINAL', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11)),
          Text('${p.awayTeam}: ${p.predictedAwayScore.toStringAsFixed(0)}  ·  ${p.homeTeam}: ${p.predictedHomeScore.toStringAsFixed(0)}'),
          Text('Ganador previsto: ${p.predictedWinner} · Prob. local: ${p.homeWinProbability.toStringAsFixed(1)}%'),
          const SizedBox(height: 8),
          const Text('RESULTADO FINAL', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11)),
          Text('${p.awayTeam}: ${actualAway?.toStringAsFixed(0) ?? "—"}  ·  ${p.homeTeam}: ${actualHome?.toStringAsFixed(0) ?? "—"}'),
          Text('Ganador real: $actualWinner'),
          const SizedBox(height: 8),
          Row(children: [
            Icon(winnerCorrect ? Icons.check_circle : Icons.cancel,
              color: winnerCorrect ? Colors.greenAccent : Colors.orangeAccent, size: 18),
            const SizedBox(width: 6),
            Expanded(child: Text(winnerCorrect ? 'Ganador acertado' : 'Ganador fallado',
              style: TextStyle(fontWeight: FontWeight.bold,
                color: winnerCorrect ? Colors.greenAccent : Colors.orangeAccent))),
          ]),
          Text('Error de puntos · visitante: ${awayError?.toStringAsFixed(1) ?? "—"} · local: ${homeError?.toStringAsFixed(1) ?? "—"}'),
          Text('Modelo: ${p.modelVersion}', style: Theme.of(context).textTheme.bodySmall),
        ]),
      ),
    );
  }

  Widget _directionalScoreErrorSummary() {
    final tooHigh = <double>[], tooLow = <double>[];
    for (final p in cloudPredictions.where((item) => item.isEvaluated)) {
      final actual = p.actual ?? {};
      final pairs = [(p.predictedHomeScore, (actual['home_score'] as num?)?.toDouble()), (p.predictedAwayScore, (actual['away_score'] as num?)?.toDouble())];
      for (final pair in pairs) {
        final real = pair.$2; if (real == null) continue;
        final difference = pair.$1 - real;
        if (difference > 0) tooHigh.add(difference);
        if (difference < 0) tooLow.add(-difference);
      }
    }
    double? avg(List<double> values) => values.isEmpty ? null : values.reduce((a,b) => a+b) / values.length;
    final high = avg(tooHigh), low = avg(tooLow);
    return Row(children: [
      Expanded(child: _metric('Error medio · real menor que predicho', high == null ? '—' : '${high.toStringAsFixed(1)} pts')),
      const SizedBox(width: 8),
      Expanded(child: _metric('Error medio · real mayor que predicho', low == null ? '—' : '${low.toStringAsFixed(1)} pts')),
    ]);
  }
  Widget _historyPage() => RefreshIndicator(
    onRefresh: refreshCloudHistory,
    child: ListView(padding: const EdgeInsets.all(16), children: [
      _previousSlateSection(),
      const Divider(height: 28),
      Container(padding: const EdgeInsets.all(14), decoration: BoxDecoration(color: const Color(0xFFFFF0E5), borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFE8C9B8))),
        child: const Text('RESUMEN DE HISTORIAL DE PREDICCIONES', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: Color(0xFFB94D2B)))),
      const SizedBox(height: 10),
      _section('Historial automático en la nube'),
      _directionalScoreErrorSummary(),
      const SizedBox(height: 8),
      const Text('Los pronósticos guardados por el motor se conservan con su versión y datos de entrada. Cuando llega el resultado final, se calcula su error sin modificar el pronóstico original.'),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(child: _metric('Guardados', '${cloudPredictions.length}')),
        const SizedBox(width: 8),
        Expanded(child: _metric('Evaluados', '$cloudEvaluatedCount')),
        const SizedBox(width: 8),
        Expanded(child: _metric('Pendientes', '$cloudPendingCount')),
      ]),
      if (cloudHistoryLoading) const Padding(
        padding: EdgeInsets.all(18), child: Center(child: CircularProgressIndicator()),
      ),
      if (cloudHistoryError != null) _empty('No se pudo cargar el historial: $cloudHistoryError'),
      if (!cloudHistoryLoading && cloudHistoryError == null && cloudPredictions.isEmpty)
        _empty('Todavía no hay pronósticos guardados en la nube.'),
      ...cloudPredictions.map(_cloudPredictionCard),
      const Divider(height: 28),
      _section('Historial manual del teléfono'),
      const Text('Estos son los pronósticos que registraste manualmente en este dispositivo.'),
      if (predictions.where((p) => p.isSettled).isEmpty) _empty('Aún no hay pronósticos manuales con resultados reales.'),
      ...predictions.where((p) => p.isSettled).map((p) => _predictionCard(p)),
    ]),
  );

  Widget _cloudPredictionCard(NbaStoredPrediction p) => Card(
    margin: const EdgeInsets.only(bottom: 10),
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(p.scheduledStart == null ? 'Fecha no disponible' : p.scheduledStart!.toLocal().toString().substring(0, 16),
          style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 6),
        Text('${p.awayTeam} vs ${p.homeTeam}',
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        const SizedBox(height: 6),
        Text('Pronóstico: ${p.predictedAwayScore.toStringAsFixed(0)} - ${p.predictedHomeScore.toStringAsFixed(0)}'),
        Text('Ganador estimado: ${p.predictedWinner} · Probabilidad local: ${p.homeWinProbability.toStringAsFixed(1)}%'),
        Text('Modelo: ${p.modelVersion}', style: Theme.of(context).textTheme.bodySmall),
        const Divider(),
        if (p.isEvaluated) ...[
          Text('Resultado real: ${p.actual!['away_score']} - ${p.actual!['home_score']}',
            style: const TextStyle(fontWeight: FontWeight.bold)),
          Text('Acierto del ganador: ${p.errorMetrics!['winner_correct'] == true ? 'Sí' : 'No'}'),
          Text('Error de puntos: local ${p.errorMetrics!['home_score_abs_error']} · visitante ${p.errorMetrics!['away_score_abs_error']}'),
          Text('Brier score: ${p.errorMetrics!['brier_score']}'),
        ] else
          const Text('Pendiente de resultado final', style: TextStyle(color: Colors.orangeAccent)),
      ]),
    ),
  );

  Widget _teamErrorCard(NbaTeamErrorSummary team) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(
            team.abbreviation.isEmpty ? team.team : '${team.team} (${team.abbreviation})',
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
          )),
          Text('${team.gamesEvaluated} partidos', style: Theme.of(context).textTheme.bodySmall),
        ]),
        const SizedBox(height: 5),
        Text('Acierto del ganador: ${team.winnerAccuracyPct.toStringAsFixed(1)}% · Casa: ${team.homeGames} · Fuera: ${team.awayGames}'),
        Text('Error medio de sus puntos: ${team.pointsMae.toStringAsFixed(1)} pts · Error del rival: ${team.opponentPointsMae.toStringAsFixed(1)} pts'),
        Text('Sesgo: ${team.pointsBias > 0 ? '+' : ''}${team.pointsBias.toStringAsFixed(1)} pts · Error de margen: ${team.marginMae.toStringAsFixed(1)} pts'),
        Text('Previsto: ${team.meanPredictedPoints.toStringAsFixed(1)} · Real: ${team.meanActualPoints.toStringAsFixed(1)}',
          style: Theme.of(context).textTheme.bodySmall),
      ]),
    ),
  );

  Widget _learningPage() {
    final cloudDone = cloudPredictions.where((p) => p.isEvaluated).toList();
    final cloudCorrect = cloudDone.where((p) => p.errorMetrics?['winner_correct'] == true).length;
    final cloudAccuracy = cloudDone.isEmpty ? null : 100 * cloudCorrect / cloudDone.length;
    final cloudMarginError = cloudDone.isEmpty ? null : cloudDone.map((p) => (p.errorMetrics?['margin_abs_error'] as num?)?.toDouble() ?? 0).reduce((a,b) => a+b) / cloudDone.length;
    final cloudBrier = cloudDone.isEmpty ? null : cloudDone.map((p) => (p.errorMetrics?['brier_score'] as num?)?.toDouble() ?? 0).reduce((a,b) => a+b) / cloudDone.length;
    final playerDone = cloudPlayerPredictions.where((p) => p.isEvaluated).toList();
    double? playerMae(String key) {
      final values = playerDone.map((p) => (p.errorMetrics?[key] as num?)?.toDouble()).whereType<double>().toList();
      return values.isEmpty ? null : values.reduce((a,b) => a+b) / values.length;
    }
    final overErrors = <double>[], underErrors = <double>[];
    for (final p in cloudDone) {
      final actual = p.actual ?? {};
      final pairs = [(p.predictedHomeScore, (actual['home_score'] as num?)?.toDouble()), (p.predictedAwayScore, (actual['away_score'] as num?)?.toDouble())];
      for (final pair in pairs) {
        final real = pair.$2; if (real == null) continue;
        final delta = pair.$1 - real;
        if (delta > 0) overErrors.add(delta);
        if (delta < 0) underErrors.add(-delta);
      }
    }
    double? mean(List<double> values) => values.isEmpty ? null : values.reduce((a,b) => a+b) / values.length;
    final versions = cloudDone.map((p) => p.modelVersion).toSet().toList()..sort();
    return RefreshIndicator(onRefresh: () async { await refreshPredictions(); await refreshPlayerPredictions(); },
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Card(color: const Color(0xFFFFF0E5), child: const Padding(padding: EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('CENTRO DE APRENDIZAJE · EVALUACIÓN AUTOMÁTICA EN LA NUBE', style: TextStyle(fontWeight: FontWeight.w900, color: Color(0xFFB94D2B), fontSize: 17)),
          SizedBox(height: 6), Text('Las predicciones originales se conservan. El sistema compara los resultados finales y registra los errores antes de evaluar cambios de modelo.'),
        ]))),
        if (cloudHistoryLoading) const LinearProgressIndicator(),
        if (cloudHistoryError != null) _empty('No se pudo cargar la evaluación: $cloudHistoryError'),
        Card(child: ExpansionTile(initiallyExpanded: true, leading: const Icon(Icons.groups, color: Color(0xFF3F4852)),
          title: const Text('Equipos', style: TextStyle(fontWeight: FontWeight.w900)), subtitle: const Text('Indicadores de predicciones colectivas'),
          childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 14), children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              SizedBox(width: 145, child: _metric('Predicciones', '${cloudPredictions.length}')),
              SizedBox(width: 145, child: _metric('Evaluados', '$cloudEvaluatedCount')),
              SizedBox(width: 145, child: _metric('Pendientes', '$cloudPendingCount')),
              SizedBox(width: 145, child: _metric('Acierto del ganador', cloudAccuracy == null ? '—' : '${cloudAccuracy.toStringAsFixed(1)}%')),
              SizedBox(width: 145, child: _metric('Error de margen', cloudMarginError == null ? '—' : '${cloudMarginError.toStringAsFixed(2)} pts')),
              SizedBox(width: 145, child: _metric('Brier score', cloudBrier == null ? '—' : cloudBrier.toStringAsFixed(3))),
            ]),
            const SizedBox(height: 8), _section('Error medio del marcador'),
            Row(children: [Expanded(child: _metric('Real menor que predicho', mean(overErrors) == null ? '—' : '${mean(overErrors)!.toStringAsFixed(1)} pts')), const SizedBox(width: 8), Expanded(child: _metric('Real mayor que predicho', mean(underErrors) == null ? '—' : '${mean(underErrors)!.toStringAsFixed(1)} pts'))]),
            const SizedBox(height: 8), _section('Evaluación por equipo'),
            if (cloudTeamAnalysis.isEmpty) _empty('Aún no hay suficientes evaluaciones de equipos.') else ...cloudTeamAnalysis.take(30).map(_teamErrorCard),
          ])),
        Card(child: ExpansionTile(leading: const Icon(Icons.person, color: Color(0xFFE8752E)),
          title: const Text('Jugadores', style: TextStyle(fontWeight: FontWeight.w900, color: Color(0xFFE8752E))), subtitle: const Text('Errores de las proyecciones individuales'),
          childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 14), children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              SizedBox(width: 145, child: _metric('Predicciones', '${cloudPlayerPredictions.length}')),
              SizedBox(width: 145, child: _metric('Evaluados', '${playerDone.length}')),
              SizedBox(width: 145, child: _metric('Pendientes', '${cloudPlayerPredictions.length - playerDone.length}')),
              SizedBox(width: 145, child: _metric('Acierto del ganador', 'No aplica')),
              SizedBox(width: 145, child: _metric('Error medio PTS', playerMae('points_abs_error') == null ? '—' : playerMae('points_abs_error')!.toStringAsFixed(1))),
              SizedBox(width: 145, child: _metric('Error medio REB', playerMae('rebounds_abs_error') == null ? '—' : playerMae('rebounds_abs_error')!.toStringAsFixed(1))),
              SizedBox(width: 145, child: _metric('Error medio 3PT', playerMae('threes_abs_error') == null ? '—' : playerMae('threes_abs_error')!.toStringAsFixed(1))),
            ]),
            const SizedBox(height: 6), const Text('En predicciones individuales no existe un ganador de partido que evaluar; por eso ese indicador se marca como no aplicable. Los errores son la diferencia absoluta media frente al boxscore final.'),
            const SizedBox(height: 8),
            if (playerDone.isEmpty) _empty('Las evaluaciones individuales aparecerán cuando existan predicciones guardadas y boxscores finales verificados.')
            else ...playerDone.take(30).map((p) => Card(margin: const EdgeInsets.only(bottom: 6), child: ListTile(title: Text(p.playerName, style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFFE8752E))), subtitle: Text('${p.teamAbbreviation} · ${p.modelVersion}'), trailing: Text('PTS ±${(p.errorMetrics?['points_abs_error'] as num?)?.toStringAsFixed(1) ?? '—'}', style: const TextStyle(fontWeight: FontWeight.w800))))),
          ])),
        Card(color: const Color(0xFFFFF0E5), child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('LABORATORIO DE APRENDIZAJE', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 18, color: Color(0xFFB94D2B))),
          const SizedBox(height: 8), Text('Pronósticos colectivos: ${cloudPredictions.length}. Evaluados: $cloudEvaluatedCount. Pendientes: $cloudPendingCount.'),
          Text('Pronósticos individuales: ${cloudPlayerPredictions.length}. Evaluados: ${playerDone.length}. Pendientes: ${cloudPlayerPredictions.length - playerDone.length}.'),
          const SizedBox(height: 8), const Text('Versiones evaluadas', style: TextStyle(fontWeight: FontWeight.bold)),
          if (versions.isEmpty) const Text('Todavía no hay versiones con resultados finales.') else ...versions.map((v) {
            final subset = cloudDone.where((p) => p.modelVersion == v).toList();
            final hits = subset.where((p) => p.errorMetrics?['winner_correct'] == true).length;
            return Text('$v · ${subset.length} partidos · ${subset.isEmpty ? '—' : (100*hits/subset.length).toStringAsFixed(1)}% acierto');
          }),
          const SizedBox(height: 8), const Text('No se promueve automáticamente una versión por una mejora pequeña: se exige evaluación temporal y evidencia consistente.'),
        ]))),
      ]),
    );
  }
  Widget _section(String t) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(t, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
  );

  Widget _empty(String t) => Card(child: Padding(
    padding: const EdgeInsets.all(18), child: Text(t, textAlign: TextAlign.center),
  ));

  Widget _metric(String label, String value) => Card(child: Padding(
    padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: Theme.of(context).textTheme.bodyMedium),
      const SizedBox(height: 8),
      Text(value, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
    ]),
  ));

  Widget _predictionCard(Prediction p, {bool allowResult = false}) => Card(
    margin: const EdgeInsets.only(bottom: 10),
    child: Padding(padding: const EdgeInsets.all(14), child: Column(
      crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${p.awayTeam} vs ${p.homeTeam}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
        Text('Partido: ${p.gameDate.toLocal().toString().substring(0, 16)}'),
        const Divider(),
        Text('Pronóstico: ${p.awayTeam} ${p.awayScore.toStringAsFixed(0)} - ${p.homeTeam} ${p.homeScore.toStringAsFixed(0)}'),
        Text('Ganador previsto: ${p.predictedWinner} · Prob. local: ${p.homeWinProbability.toStringAsFixed(1)}%'),
        Text('Modelo: ${p.modelVersion} · Guardado: ${p.createdAt.toLocal().toString().substring(0,16)}'),
        if (p.isSettled) ...[
          const SizedBox(height: 6),
          Text('Resultado real: ${p.actualAwayScore} - ${p.actualHomeScore} · Ganador: ${p.actualWinner}'),
          Text(p.predictedWinner == p.actualWinner ? 'Ganador acertado' : 'Ganador no acertado',
            style: TextStyle(color: p.predictedWinner == p.actualWinner ? Colors.greenAccent : Colors.orangeAccent)),
        ] else if (allowResult) ...[
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: () => addActual(p), icon: const Icon(Icons.fact_check), label: const Text('Añadir resultado real')),
        ],
      ],
    )),
  );
}

class PredictionDialog extends StatefulWidget {
  const PredictionDialog({super.key});
  @override
  State<PredictionDialog> createState() => _PredictionDialogState();
}
class _PredictionDialogState extends State<PredictionDialog> {
  final away = TextEditingController(), home = TextEditingController();
  final winner = TextEditingController(), version = TextEditingController(text: 'baseline-0.1');
  final awayScore = TextEditingController(), homeScore = TextEditingController(), probability = TextEditingController(text: '50');
  DateTime date = DateTime.now().add(const Duration(days: 1));
  @override
  void dispose() { away.dispose(); home.dispose(); winner.dispose(); version.dispose(); awayScore.dispose(); homeScore.dispose(); probability.dispose(); super.dispose(); }
  double? n(TextEditingController c) => double.tryParse(c.text.trim());
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Nuevo pronóstico'),
    content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
      _field(away, 'Equipo visitante'), _field(home, 'Equipo local'),
      _field(awayScore, 'Puntos previstos visitante', numeric: true),
      _field(homeScore, 'Puntos previstos local', numeric: true),
      _field(winner, 'Ganador previsto'),
      _field(probability, 'Probabilidad de victoria local (%)', numeric: true),
      _field(version, 'Versión del modelo'),
      const SizedBox(height: 8),
      Text('Fecha del partido: ${date.toLocal().toString().substring(0,10)}'),
      TextButton(onPressed: () async {
        final d = await showDatePicker(context: context, initialDate: date, firstDate: DateTime(2020), lastDate: DateTime(2035));
        if (d != null) setState(() => date = d);
      }, child: const Text('Cambiar fecha')),
    ])),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
      FilledButton(onPressed: () {
        final a = n(awayScore), h = n(homeScore), prob = n(probability);
        if ([away.text, home.text, winner.text, version.text].any((s) => s.trim().isEmpty) ||
            a == null || h == null || prob == null || prob < 0 || prob > 100) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Completa los campos y revisa los números (probabilidad 0-100).')));
          return;
        }
        final now = DateTime.now();
        Navigator.pop(context, Prediction(
          id: '${now.microsecondsSinceEpoch}', createdAt: now, gameDate: date,
          awayTeam: away.text.trim(), homeTeam: home.text.trim(),
          predictedWinner: winner.text.trim(), awayScore: a, homeScore: h,
          homeWinProbability: prob, modelVersion: version.text.trim(),
        ));
      }, child: const Text('Guardar')),
    ],
  );
  Widget _field(TextEditingController c, String label, {bool numeric = false}) =>
    Padding(padding: const EdgeInsets.only(bottom: 8), child: TextField(
      controller: c, keyboardType: numeric ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text,
      decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
    ));
}

class ActualResultDialog extends StatefulWidget {
  final Prediction prediction;
  const ActualResultDialog({super.key, required this.prediction});
  @override
  State<ActualResultDialog> createState() => _ActualResultDialogState();
}
class _ActualResultDialogState extends State<ActualResultDialog> {
  final away = TextEditingController(), home = TextEditingController();
  @override
  void dispose() { away.dispose(); home.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Registrar marcador real'),
    content: Column(mainAxisSize: MainAxisSize.min, children: [
      Text(widget.prediction.awayTeam), TextField(controller: away, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Puntos reales visitante')),
      const SizedBox(height: 10), Text(widget.prediction.homeTeam),
      TextField(controller: home, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Puntos reales local')),
    ]),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
      FilledButton(onPressed: () {
        final a = int.tryParse(away.text), h = int.tryParse(home.text);
        if (a == null || h == null || a < 0 || h < 0 || a == h) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Introduce dos marcadores válidos; un partido NBA no termina empatado.')));
          return;
        }
        Navigator.pop(context, (a, h));
      }, child: const Text('Guardar resultado')),
    ],
  );
}
