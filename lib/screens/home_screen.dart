import 'package:flutter/material.dart';
import '../services/nba_data_service.dart';
import '../models/prediction.dart';
import '../services/prediction_store.dart';
import '../services/nba_prediction_service.dart';
import '../services/nba_prediction_history_service.dart';
import '../services/nba_player_prediction_service.dart';
import 'player_stats_screen.dart';
import '../services/app_update_service.dart';

class _NbaAnalyticsLogo extends StatelessWidget {
  final double size;
  const _NbaAnalyticsLogo({required this.size});

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size, height: size,
    child: Stack(children: [
      CustomPaint(size: Size(size, size), painter: _BasketballLogoPainter()),
      Positioned(right: 0, bottom: 0, child: Container(
        width: size * .43, height: size * .43,
        decoration: BoxDecoration(
          color: const Color(0xFF1769AA),
          border: Border.all(color: const Color(0xFF10141D), width: 1.5),
          borderRadius: BorderRadius.circular(size),
        ),
        alignment: Alignment.center,
        child: Text('A', style: TextStyle(
          color: Colors.white, fontWeight: FontWeight.w900, fontSize: size * .25,
        )),
      )),
    ]),
  );
}

class _BasketballLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width * .45;
    final ball = Paint()..color = const Color(0xFFEF6C35);
    final lines = Paint()
      ..color = const Color(0xFF20202A)
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * .055;
    canvas.drawCircle(center, radius, ball);
    canvas.drawCircle(center, radius, lines);
    canvas.drawLine(Offset(center.dx - radius, center.dy),
        Offset(center.dx + radius, center.dy), lines);
    canvas.drawLine(Offset(center.dx, center.dy - radius),
        Offset(center.dx, center.dy + radius), lines);
    final leftArc = Path()
      ..moveTo(center.dx - radius * .25, center.dy - radius * .97)
      ..cubicTo(center.dx - radius * .85, center.dy - radius * .35,
          center.dx - radius * .85, center.dy + radius * .35,
          center.dx - radius * .25, center.dy + radius * .97);
    final rightArc = Path()
      ..moveTo(center.dx + radius * .25, center.dy - radius * .97)
      ..cubicTo(center.dx + radius * .85, center.dy - radius * .35,
          center.dx + radius * .85, center.dy + radius * .35,
          center.dx + radius * .25, center.dy + radius * .97);
    canvas.drawPath(leftArc, lines);
    canvas.drawPath(rightArc, lines);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
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

  @override
  void initState() { super.initState(); refresh(); refreshNbaData(); refreshPredictions(); refreshPlayerPredictions(); }

  Future<void> _checkForAppUpdate() async {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Buscando actualizaciones…')),
    );
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
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Descargando APK… Android te pedirá confirmar la instalación.')),
      );
      await appUpdateService.downloadAndInstall(update);
    } catch (error) {
      if (!mounted) return;
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
      _liveNbaPage(), const PlayerStatsScreen(), _gamesPage(), _historyPage(), _learningPage(),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Row(mainAxisSize: MainAxisSize.min, children: [
          const _NbaAnalyticsLogo(size: 34),
          const SizedBox(width: 10),
          const Text('NBA ANALYTICS', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.2)),
        ]),
        actions: [
          IconButton(
            onPressed: () { refresh(); refreshNbaData(); refreshPredictions(); refreshPlayerPredictions(); },
            icon: const Icon(Icons.refresh),
            tooltip: 'Actualizar datos',
          ),
          PopupMenuButton<String>(
            tooltip: 'Menú',
            onSelected: (value) {
              if (value == 'app_update') _checkForAppUpdate();
            },
            itemBuilder: (context) => const [
              PopupMenuItem(
                value: 'app_update',
                child: Row(children: [
                  Icon(Icons.system_update_alt),
                  SizedBox(width: 10),
                  Text('Actualizar APK'),
                ]),
              ),
            ],
          ),
        ],
      ),
      body: loading ? const Center(child: CircularProgressIndicator()) : pages[tab],
      floatingActionButton: null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (v) => setState(() => tab = v),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.sports_basketball), label: 'NBA'),
          NavigationDestination(icon: Icon(Icons.person_search), label: 'Jugadores'),
          NavigationDestination(icon: Icon(Icons.edit_note), label: 'Pronósticos'),
          NavigationDestination(icon: Icon(Icons.history), label: 'Historial'),
          NavigationDestination(icon: Icon(Icons.insights), label: 'Aprendizaje'),
        ],
      ),
    );
  }

  DateTime _localSlateDay(DateTime value) {
    final local = value.toLocal();
    return DateTime(local.year, local.month, local.day);
  }

  String _formatSlateDate(DateTime date) =>
      '${date.day.toString().padLeft(2, '0')}/${date.month.toString().padLeft(2, '0')}/${date.year}';

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
    child: ListView(padding: const EdgeInsets.all(16), children: [
      _section('NBA · Partidos y marcadores'),
      Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Fuente de datos: ESPN', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 5),
          Text(nbaUpdatedAt == null
              ? 'Conectando con NBA Analytics…'
              : 'Actualizado: ' + nbaUpdatedAt!.toLocal().toString().substring(0, 16)),
          const SizedBox(height: 4),
          const Text('El calendario se sincroniza en la nube cada 15 minutos. Desliza hacia abajo para actualizar ahora.',
              style: TextStyle(fontSize: 12)),
        ]),
      )),
      if (nbaMeta.isNotEmpty) Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Cobertura de datos · ventana mostrada', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 6),
            Text('Partidos: ${nbaMeta['games'] ?? 0} · Equipos: ${nbaMeta['teams'] ?? 0}'),
            Text('Registros individuales: ${nbaMeta['player_stat_rows'] ?? 0}'),
            Text('Registros por equipo: ${nbaMeta['team_stat_rows'] ?? 0}'),
            const SizedBox(height: 4),
            const Text('Estos recuentos corresponden a los partidos de esta ventana; no representan el total histórico.', style: TextStyle(fontSize: 11)),
          ]),
        ),
      ),
      if (nbaLoading) const Padding(
        padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()),
      ),
      if (nbaError != null) Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Text('No se pudo conectar: ' + nbaError!, style: const TextStyle(color: Colors.orangeAccent)),
      )),
      if (!nbaLoading && nbaGames.isEmpty && nbaError == null)
        _empty('No hay partidos en la ventana actual. Vuelve a actualizar más tarde.'),
      _section(_latestCompletedSlateDate == null
          ? 'Resultados de la jornada'
          : 'Resultados de la jornada · ${_formatSlateDate(_latestCompletedSlateDate!)}'),
      if (_latestCompletedSlateGames.isEmpty)
        _empty('Todavía no hay una jornada completamente finalizada en los datos recientes.')
      else
        ..._latestCompletedSlateGames.map(_nbaGameCard),
      const SizedBox(height: 8),
      _section(_nextSlateDate == null
          ? 'Próxima jornada'
          : 'Próxima jornada · ${_formatSlateDate(_nextSlateDate!)}'),
      if (_nextSlateGames.isEmpty)
        _empty('No hay partidos programados en la próxima jornada.')
      else
        ..._nextSlateGames.map(_nbaGameCard),
      const SizedBox(height: 12),
      _predictionSection(),
      const SizedBox(height: 8),
      _playerPredictionSection(),
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
    final total = predictionMeta['historical_final_games'] ?? 0;
    final slateStatus = (predictionMeta['slate_status'] ?? 'unknown').toString();
    final slateDate = (predictionMeta['slate_date'] ?? '—').toString();
    final slateGames = predictionMeta['slate_games'] ?? 0;
    final slateMessage = slateStatus == 'in_progress'
        ? 'Jornada $slateDate en curso: hay partidos sin terminar. La APK espera a que cierre toda la jornada antes de preparar la siguiente.'
        : slateStatus == 'ready'
            ? 'Próxima jornada: $slateDate · $slateGames partidos. Solo se pronostica esta fecha.'
            : 'No hay una próxima jornada disponible en el calendario sincronizado.';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _section('Predicciones de la próxima jornada'),
      Card(child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(slateStatus == 'in_progress' ? Icons.hourglass_top : Icons.calendar_today,
            color: slateStatus == 'in_progress' ? Colors.orangeAccent : Colors.lightBlueAccent),
          const SizedBox(width: 10),
          Expanded(child: Text(slateMessage)),
        ]),
      )),
      Card(
        color: const Color(0xFF202B3B),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.auto_graph, color: Colors.lightBlueAccent),
              const SizedBox(width: 8),
              const Expanded(child: Text('MODELO EXPERIMENTAL', style: TextStyle(fontWeight: FontWeight.bold))),
              Text(predictionModelVersion, style: const TextStyle(fontSize: 11)),
            ]),
            const SizedBox(height: 7),
            const Text('Usa los últimos 10 partidos finalizados de cada equipo. Requiere al menos 5 por equipo. La probabilidad todavía no está calibrada.'),
            const SizedBox(height: 5),
            Text('Resultados históricos disponibles: $total', style: const TextStyle(fontSize: 11)),
          ]),
        ),
      ),
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
      ...nbaForecasts.map((forecast) => Card(
        margin: const EdgeInsets.only(bottom: 10),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(forecast.scheduledStart.toLocal().toString().substring(0, 16),
              style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            Text('${forecast.awayTeam} vs ${forecast.homeTeam}',
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 8),
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text(forecast.awayTeam, style: const TextStyle(fontSize: 12)),
              Text(forecast.awayTeam == forecast.predictedWinner ? 'GANADOR PROBABLE' : ''),
            ]),
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text(forecast.predictedAwayScore.toStringAsFixed(0),
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
              Text(forecast.predictedHomeScore.toStringAsFixed(0),
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
              Text(forecast.homeTeam, style: const TextStyle(fontSize: 12)),
            ]),
            const Divider(),
            Text('Ganador estimado: ${forecast.predictedWinner}',
              style: const TextStyle(fontWeight: FontWeight.bold)),
            Text('Probabilidad local: ${forecast.homeWinProbability.toStringAsFixed(1)}% · visitante: ${forecast.awayWinProbability.toStringAsFixed(1)}%'),
            Text('Últimos partidos: visitante ${forecast.awayRecentRecord} · local ${forecast.homeRecentRecord}',
              style: Theme.of(context).textTheme.bodySmall),
            Text('Muestra: ${forecast.awaySample} / ${forecast.homeSample} partidos',
              style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
      )),
    ]);
  }

  Widget _playerPredictionSection() {
    final grouped = <String, List<NbaPlayerForecast>>{};
    for (final forecast in playerForecasts) {
      grouped.putIfAbsent(forecast.gameId, () => []).add(forecast);
    }
    final verifiedGames = playerPredictionMeta['games_with_verified_availability'] ?? 0;
    final checkedGames = playerPredictionMeta['games_checked'] ?? 0;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _section('Predicciones de los jugadores titulares'),
      const Text(
        'Solo aparecen jugadores con titularidad confirmada y sin lesión reportada por ESPN. Si falta la confirmación, NBA Analytics los omite.',
        style: TextStyle(fontSize: 12),
      ),
      const SizedBox(height: 8),
      if (playerPredictionLoading)
        const Padding(padding: EdgeInsets.all(18), child: Center(child: CircularProgressIndicator())),
      if (playerPredictionError != null)
        Card(child: Padding(
          padding: const EdgeInsets.all(12),
          child: Text('No se pudieron cargar las predicciones individuales: $playerPredictionError'),
        )),
      if (!playerPredictionLoading && playerPredictionError == null && playerForecasts.isEmpty)
        _empty('Todavía no hay jugadores elegibles. Esperamos a que ESPN confirme los quintetos titulares y publique el informe de lesiones completo; no hacemos predicciones por suposición.'),
      if (!playerPredictionLoading && playerPredictionError == null && playerForecasts.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text('Partidos revisados: $checkedGames · Con disponibilidad verificada: $verifiedGames',
            style: Theme.of(context).textTheme.bodySmall),
        ),
      ...grouped.entries.map((entry) {
        final players = entry.value;
        NbaForecast? gameForecast;
        for (final item in nbaForecasts) {
          if (item.gameId == entry.key) { gameForecast = item; break; }
        }
        final matchup = gameForecast == null
            ? 'Jugadores del partido'
            : '${gameForecast.awayTeam} vs ${gameForecast.homeTeam}';
        return Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(matchup, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
              Text(players.first.scheduledStart.toLocal().toString().substring(0, 16),
                style: Theme.of(context).textTheme.bodySmall),
              const Divider(),
              ...players.map((p) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 7),
                child: Row(children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(p.playerName, style: const TextStyle(fontWeight: FontWeight.bold)),
                    Text('${p.teamAbbreviation} · ${p.position ?? 'Titular'} · muestra ${p.sampleGames} partidos',
                      style: Theme.of(context).textTheme.bodySmall),
                  ])),
                  Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Text('${p.points.toStringAsFixed(1)} PTS',
                      style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16)),
                    Text('${p.rebounds.toStringAsFixed(1)} REB · ${p.assists.toStringAsFixed(1)} AST',
                      style: Theme.of(context).textTheme.bodySmall),
                    Text('${p.threes.toStringAsFixed(1)} 3PT · ${p.minutes.toStringAsFixed(1)} MIN',
                      style: Theme.of(context).textTheme.bodySmall),
                  ]),
                ]),
              )),
            ]),
          ),
        );
      }),
    ]);
  }

  Widget _nbaGameCard(NbaGame game) {
    final away = game.awayTeam;
    final home = game.homeTeam;
    final isFinal = game.status == 'final';
    final isLive = game.status == 'in_progress';
    final statusLabel = isFinal ? 'FINAL' : (isLive ? 'EN JUEGO' : 'PROGRAMADO');
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(padding: const EdgeInsets.all(14), child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text('Hora · ' + game.scheduledStart.toLocal().toString().substring(11, 16),
                style: Theme.of(context).textTheme.bodySmall),
            Text(statusLabel, style: TextStyle(
              fontWeight: FontWeight.bold,
              color: isLive ? Colors.greenAccent : (isFinal ? Colors.blueAccent : Colors.orangeAccent),
            )),
          ]),
          const SizedBox(height: 12),
          _teamScoreRow(away?.abbreviation ?? 'VIS', away?.name ?? 'Visitante', game.awayScore),
          const SizedBox(height: 8),
          _teamScoreRow(home?.abbreviation ?? 'LOC', home?.name ?? 'Local', game.homeScore),
          if (game.statusDetail != null && game.statusDetail!.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(game.statusDetail!, style: Theme.of(context).textTheme.bodySmall),
          ],
        ],
      )),
    );
  }

  Widget _teamScoreRow(String abbreviation, String name, int? score) => Row(
    children: [
      SizedBox(width: 48, child: Text(abbreviation, style: const TextStyle(fontWeight: FontWeight.w900))),
      Expanded(child: Text(name)),
      Text(score?.toString() ?? '—', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
    ],
  );

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
      const Text('NBA Analytics consulta el calendario y las estadísticas históricas, calcula los marcadores y guarda cada pronóstico en la nube. No necesitas introducir equipos ni puntos manualmente.'),
      const SizedBox(height: 12),
      _predictionSection(),
      const SizedBox(height: 12),
      _playerPredictionSection(),
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

  Widget _historyPage() => RefreshIndicator(
    onRefresh: refreshCloudHistory,
    child: ListView(padding: const EdgeInsets.all(16), children: [
      _previousSlateSection(),
      const Divider(height: 28),
      _section('Historial automático en la nube'),
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
    final done = predictions.where((p) => p.isSettled).toList();
    final correct = done.where((p) => p.predictedWinner == p.actualWinner).length;
    final avgError = done.isEmpty ? null : done.map((p) =>
      ((p.homeScore - p.actualHomeScore!).abs() + (p.awayScore - p.actualAwayScore!).abs()) / 2
    ).reduce((a,b) => a+b) / done.length;
    final accuracy = done.isEmpty ? null : 100 * correct / done.length;
    final versions = done.map((p) => p.modelVersion).toSet().toList()..sort();
    final cloudDone = cloudPredictions.where((p) => p.isEvaluated).toList();
    final cloudCorrect = cloudDone.where((p) => p.errorMetrics!['winner_correct'] == true).length;
    final cloudAccuracy = cloudDone.isEmpty ? null : 100 * cloudCorrect / cloudDone.length;
    final cloudMarginError = cloudDone.isEmpty ? null : cloudDone
        .map((p) => (p.errorMetrics!['margin_abs_error'] as num).toDouble())
        .reduce((a, b) => a + b) / cloudDone.length;
    final cloudBrier = cloudDone.isEmpty ? null : cloudDone
        .map((p) => (p.errorMetrics!['brier_score'] as num).toDouble())
        .reduce((a, b) => a + b) / cloudDone.length;
    return ListView(padding: const EdgeInsets.all(16), children: [
      _section('Centro de aprendizaje'),
      const Text('La nube compara cada pronóstico guardado con el marcador final. Estas métricas evalúan el modelo, pero todavía no cambian sus parámetros automáticamente.'),
      const SizedBox(height: 12),
      _section('Experimento · promedio histórico + últimos 10'),
      Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Candidato historical-blend-0.1',
            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 6),
          const Text('Combina al 50 % el promedio histórico de puntos anotados y permitidos con el promedio de los últimos 10 partidos. Prueba walk-forward inicial: 189 partidos, sin utilizar resultados futuros.'),
          const SizedBox(height: 12),
          Table(
            columnWidths: const {
              0: FlexColumnWidth(1.6), 1: FlexColumnWidth(1), 2: FlexColumnWidth(1),
            },
            children: const [
              TableRow(children: [
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Métrica', style: TextStyle(fontWeight: FontWeight.bold))),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Actual', textAlign: TextAlign.end, style: TextStyle(fontWeight: FontWeight.bold))),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Candidato', textAlign: TextAlign.end, style: TextStyle(fontWeight: FontWeight.bold))),
              ]),
              TableRow(children: [
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Acierto ganador')),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('67,72 %', textAlign: TextAlign.end)),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('67,72 %', textAlign: TextAlign.end)),
              ]),
              TableRow(children: [
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Error total')),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('16,11 pts', textAlign: TextAlign.end)),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('16,06 pts', textAlign: TextAlign.end)),
              ]),
              TableRow(children: [
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Error de margen')),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('9,49 pts', textAlign: TextAlign.end)),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('9,45 pts', textAlign: TextAlign.end)),
              ]),
              TableRow(children: [
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Brier score')),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('0,2041', textAlign: TextAlign.end)),
                Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('0,2032', textAlign: TextAlign.end)),
              ]),
            ],
          ),
          const SizedBox(height: 8),
          const Text('Estado: candidato no promovido. La mejora es mínima y el promedio histórico por sí solo rindió ligeramente mejor. Mantendremos el motor actual hasta reunir más partidos.',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
        ]),
      )),
      const SizedBox(height: 12),
      _section('Evaluación automática en la nube'),
      Row(children: [
        Expanded(child: _metric('Pronósticos', '${cloudPredictions.length}')),
        const SizedBox(width: 8),
        Expanded(child: _metric('Evaluados', '$cloudEvaluatedCount')),
        const SizedBox(width: 8),
        Expanded(child: _metric('Pendientes', '$cloudPendingCount')),
      ]),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(child: _metric('Acierto ganador', cloudAccuracy == null ? '—' : '${cloudAccuracy.toStringAsFixed(1)}%')),
        const SizedBox(width: 8),
        Expanded(child: _metric('Error de margen', cloudMarginError == null ? '—' : '${cloudMarginError.toStringAsFixed(1)} pts')),
        const SizedBox(width: 8),
        Expanded(child: _metric('Brier score', cloudBrier == null ? '—' : cloudBrier.toStringAsFixed(3))),
      ]),
      const SizedBox(height: 16),
      _section('Errores por equipo · pronósticos automáticos'),
      const Text('El error de puntos mide cuánto se desvía el marcador previsto de cada equipo. El sesgo positivo indica que el modelo suele pronosticarle más puntos de los que anota; el negativo indica lo contrario.'),
      if (cloudTeamAnalysis.isEmpty)
        _empty('Todavía no hay pronósticos automáticos evaluados para comparar equipos. Esta sección se llenará después de que terminen las próximas jornadas.')
      else
        ...cloudTeamAnalysis.take(30).map(_teamErrorCard),
      const SizedBox(height: 16),
      Row(children: [
        Expanded(child: _metric('Partidos evaluados', '${done.length}')),
        const SizedBox(width: 10),
        Expanded(child: _metric('Acierto ganador', accuracy == null ? '—' : '${accuracy.toStringAsFixed(1)}%')),
      ]),
      const SizedBox(height: 10),
      _metric('Error medio por equipo', avgError == null ? '—' : '${avgError.toStringAsFixed(1)} puntos'),
      const SizedBox(height: 18),
      _section('Versiones del modelo'),
      if (versions.isEmpty) _empty('La primera versión se registrará al guardar un pronóstico.')
      else ...versions.map((v) {
        final subset = done.where((p) => p.modelVersion == v).toList();
        final hits = subset.where((p) => p.predictedWinner == p.actualWinner).length;
        return Card(child: ListTile(
          title: Text(v), subtitle: Text('${subset.length} partidos evaluados · ${subset.isEmpty ? 0 : (100*hits/subset.length).toStringAsFixed(1)}% de acierto'),
        ));
      }),
      const SizedBox(height: 12),
      const Text('Próxima etapa: ampliar el historial validado, comparar nuevos candidatos mediante pruebas temporales y promover un modelo solo cuando demuestre una mejora consistente.'),
    ]);
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
