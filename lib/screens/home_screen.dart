import 'package:flutter/material.dart';
import '../services/nba_data_service.dart';
import '../models/prediction.dart';
import '../services/prediction_store.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final store = PredictionStore();
  final nbaService = NbaDataService();
  int tab = 0;
  List<NbaGame> nbaGames = [];
  bool nbaLoading = true;
  String? nbaError;
  DateTime? nbaUpdatedAt;
  Map<String, dynamic> nbaMeta = {};
  List<NbaPlayerGameStat> nbaPlayerStats = [];
  List<Prediction> predictions = [];
  bool loading = true;

  @override
  void initState() { super.initState(); refresh(); refreshNbaData(); }

  Future<void> refresh() async {
    final data = await store.load();
    if (!mounted) return;
    setState(() { predictions = data; loading = false; });
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
      _liveNbaPage(), _gamesPage(), _historyPage(), _learningPage(),
    ];
    return Scaffold(
      appBar: AppBar(
        title: const Text('NBA ANALYTICS', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.2)),
        actions: [IconButton(onPressed: () { refresh(); refreshNbaData(); }, icon: const Icon(Icons.refresh))],
      ),
      body: loading ? const Center(child: CircularProgressIndicator()) : pages[tab],
      floatingActionButton: tab == 1 ? FloatingActionButton.extended(
        onPressed: addPrediction, icon: const Icon(Icons.add), label: const Text('Registrar pronóstico'),
      ) : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (v) => setState(() => tab = v),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.sports_basketball), label: 'NBA'),
          NavigationDestination(icon: Icon(Icons.edit_note), label: 'Pronósticos'),
          NavigationDestination(icon: Icon(Icons.history), label: 'Historial'),
          NavigationDestination(icon: Icon(Icons.insights), label: 'Aprendizaje'),
        ],
      ),
    );
  }

  Widget _liveNbaPage() => RefreshIndicator(
    onRefresh: refreshNbaData,
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
      ...nbaGames.map(_nbaGameCard),
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
            Text(game.scheduledStart.toLocal().toString().substring(0, 16),
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
    onRefresh: refresh,
    child: ListView(padding: const EdgeInsets.all(16), children: [
      _notice(),
      const SizedBox(height: 14),
      _section('Pronósticos registrados'),
      if (predictions.isEmpty) _empty('Todavía no hay pronósticos. Registra uno antes del inicio del partido.'),
      ...predictions.map((p) => _predictionCard(p, allowResult: !p.isSettled)),
    ]),
  );

  Widget _historyPage() => ListView(padding: const EdgeInsets.all(16), children: [
    _section('Historial verificable'),
    const Text('Cada pronóstico conserva sus valores originales. Al añadir el marcador real solo se completa el resultado; no se reescribe el pronóstico.'),
    const SizedBox(height: 12),
    if (predictions.where((p) => p.isSettled).isEmpty) _empty('Aún no hay partidos con resultados reales registrados.'),
    ...predictions.where((p) => p.isSettled).map((p) => _predictionCard(p)),
  ]);

  Widget _learningPage() {
    final done = predictions.where((p) => p.isSettled).toList();
    final correct = done.where((p) => p.predictedWinner == p.actualWinner).length;
    final avgError = done.isEmpty ? null : done.map((p) =>
      ((p.homeScore - p.actualHomeScore!).abs() + (p.awayScore - p.actualAwayScore!).abs()) / 2
    ).reduce((a,b) => a+b) / done.length;
    final accuracy = done.isEmpty ? null : 100 * correct / done.length;
    final versions = done.map((p) => p.modelVersion).toSet().toList()..sort();
    return ListView(padding: const EdgeInsets.all(16), children: [
      _section('Centro de aprendizaje'),
      const Text('Las métricas se calculan únicamente con pronósticos que ya tienen marcador real. No se afirma que el modelo aprenda automáticamente todavía.'),
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
      const Text('Próxima etapa: incorporar datos NBA fiables, predicciones automáticas y entrenamiento validado con separación temporal entre entrenamiento y evaluación.'),
    ]);
  }

  Widget _notice() => Card(
    color: const Color(0xFF202B3B),
    child: const Padding(padding: EdgeInsets.all(14), child: Column(
      crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('BASE FUNCIONAL · MODO LOCAL', style: TextStyle(fontWeight: FontWeight.bold)),
        SizedBox(height: 6),
        Text('Esta versión guarda pronósticos y resultados en el teléfono. Todavía no descarga partidos NBA ni genera predicciones automáticas.'),
      ],
    )),
  );

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
