import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../services/nba_data_service.dart';
import '../services/nba_player_prediction_service.dart';
import '../services/nba_prediction_service.dart';

class MatchupPredictionCard extends StatefulWidget {
  final NbaForecast forecast;
  final NbaTeam? homeTeam;
  final NbaTeam? awayTeam;
  final List<NbaPlayerForecast> players;

  const MatchupPredictionCard({
    super.key, required this.forecast, required this.homeTeam,
    required this.awayTeam, required this.players,
  });

  @override
  State<MatchupPredictionCard> createState() => _MatchupPredictionCardState();
}

class _MatchupPredictionCardState extends State<MatchupPredictionCard> {
  late Future<List<Map<String, dynamic>>> _headToHead;

  @override
  void initState() {
    super.initState();
    _headToHead = _loadHeadToHead();
  }

  Future<List<Map<String, dynamic>>> _loadHeadToHead() async {
    final homeId = widget.homeTeam?.id;
    final awayId = widget.awayTeam?.id;
    if (homeId == null || awayId == null) return [];
    final response = await Supabase.instance.client.functions.invoke(
      'nba-public-data',
      body: {'action': 'head_to_head', 'home_team_id': homeId, 'away_team_id': awayId},
    );
    if (response.status < 200 || response.status >= 300 || response.data is! Map) {
      throw Exception('No se pudo consultar el historial directo.');
    }
    final data = Map<String, dynamic>.from(response.data as Map);
    if (data['ok'] != true) throw Exception((data['error'] ?? 'Historial no disponible').toString());
    return (data['games'] as List? ?? []).whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e)).toList();
  }

  double _impact(NbaPlayerForecast p) => p.points + p.rebounds * 1.2 + p.assists * 1.5;

  Widget _teamLogo(String? abbreviation) {
    final raw = (abbreviation ?? '').toUpperCase();
    const aliases = {'GSW': 'gs', 'NY': 'ny', 'NO': 'no', 'SA': 'sa', 'UTAH': 'utah'};
    final code = aliases[raw] ?? raw.toLowerCase();
    if (code.isEmpty) return const Icon(Icons.sports_basketball, color: Color(0xFFEF6C35), size: 42);
    return Image.network(
      'https://a.espncdn.com/i/teamlogos/nba/500/$code.png',
      width: 48, height: 48, fit: BoxFit.contain,
      errorBuilder: (_, __, ___) => const Icon(Icons.sports_basketball, color: Color(0xFFEF6C35), size: 42),
    );
  }

  String _date(dynamic value) {
    final parsed = DateTime.tryParse((value ?? '').toString());
    if (parsed == null) return 'Fecha —';
    final d = parsed.toLocal();
    return '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
  }

  Widget _playerGroup(String teamName, String abbreviation) {
    final players = widget.players.where((p) => p.teamAbbreviation.toUpperCase() == abbreviation.toUpperCase()).toList()
      ..sort((a, b) => _impact(b).compareTo(_impact(a)));
    final top = players.take(4).toList();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$teamName · jugadores más influyentes', style: const TextStyle(fontWeight: FontWeight.w800, color: Color(0xFF174A7E))),
        if (top.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('Sin pronósticos individuales verificados para este equipo.')),
        ...top.asMap().entries.map((entry) {
          final p = entry.value;
          return Container(
            margin: const EdgeInsets.only(top: 6),
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(color: entry.key.isEven ? const Color(0xFFF0F5FA) : const Color(0xFFFFF4EA), borderRadius: BorderRadius.circular(10)),
            child: Row(children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(p.playerName, style: const TextStyle(fontWeight: FontWeight.bold)),
                Text('${p.position ?? 'Titular'} · ${p.sampleGames} partidos de muestra', style: const TextStyle(fontSize: 11, color: Color(0xFF667788))),
              ])),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text('${p.points.toStringAsFixed(1)} PTS', style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 15, color: Color(0xFF174A7E))),
                Text('${p.rebounds.toStringAsFixed(1)} REB · ${p.assists.toStringAsFixed(1)} AST', style: const TextStyle(fontSize: 11)),
                Text('${p.threes.toStringAsFixed(1)} 3PT · ${p.minutes.toStringAsFixed(1)} MIN', style: const TextStyle(fontSize: 11)),
              ]),
            ]),
          );
        }),
      ]),
    );
  }

  Widget _predictionTab() {
    final f = widget.forecast;
    return ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 16), children: [
      Row(children: [
        Expanded(child: Column(children: [
          _teamLogo(widget.awayTeam?.abbreviation),
          Text(f.awayTeam, textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.bold)),
          Text(f.predictedAwayScore.toStringAsFixed(0), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
          Text('${f.awayWinProbability.toStringAsFixed(1)}% prob.', style: const TextStyle(fontSize: 12)),
        ])),
        const Text('VS', style: TextStyle(fontWeight: FontWeight.w900, color: Color(0xFFEF6C35))),
        Expanded(child: Column(children: [
          _teamLogo(widget.homeTeam?.abbreviation),
          Text(f.homeTeam, textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.bold)),
          Text(f.predictedHomeScore.toStringAsFixed(0), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
          Text('${f.homeWinProbability.toStringAsFixed(1)}% prob.', style: const TextStyle(fontSize: 12)),
        ])),
      ]),
      const SizedBox(height: 8),
      Text('Ganador estimado: ${f.predictedWinner}', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w900)),
      const Divider(height: 20),
      const Text('Pronósticos individuales', style: TextStyle(fontWeight: FontWeight.w900)),
      const Text('Solo se muestran jugadores con titularidad confirmada y disponibilidad verificada. Se ordenan por impacto estimado (puntos, rebotes y asistencias).', style: TextStyle(fontSize: 11, color: Color(0xFF667788))),
      _playerGroup(f.awayTeam, widget.awayTeam?.abbreviation ?? ''),
      _playerGroup(f.homeTeam, widget.homeTeam?.abbreviation ?? ''),
    ]);
  }

  Widget _headToHeadTab() => FutureBuilder<List<Map<String, dynamic>>>(
    future: _headToHead,
    builder: (context, snapshot) {
      if (snapshot.connectionState == ConnectionState.waiting) return const Center(child: CircularProgressIndicator());
      if (snapshot.hasError) return Center(child: Padding(padding: const EdgeInsets.all(16), child: Text(snapshot.error.toString())));
      final games = snapshot.data ?? [];
      if (games.isEmpty) return const Center(child: Padding(padding: EdgeInsets.all(16), child: Text('No hay cinco enfrentamientos históricos completos en los datos recopilados.')));
      return ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Últimos enfrentamientos directos finalizados', style: TextStyle(fontWeight: FontWeight.w900)),
        const SizedBox(height: 8),
        ...games.map((g) => Card(
          color: const Color(0xFFF0F5FA),
          child: Padding(padding: const EdgeInsets.all(10), child: Column(children: [
            Text(_date(g['date']), style: const TextStyle(fontSize: 11, color: Color(0xFF667788))),
            Row(children: [
              Expanded(child: Text(g['away_team']?.toString() ?? 'Visitante', textAlign: TextAlign.end, style: const TextStyle(fontWeight: FontWeight.bold))),
              const SizedBox(width: 6),
              Text('${g['away_score']} - ${g['home_score']}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
              const SizedBox(width: 6),
              Expanded(child: Text(g['home_team']?.toString() ?? 'Local', style: const TextStyle(fontWeight: FontWeight.bold))),
            ]),
            Text('Ganador: ${g['winner']}', style: const TextStyle(fontSize: 11)),
          ])),
        )),
      ]);
    },
  );

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 12),
    clipBehavior: Clip.antiAlias,
    child: DefaultTabController(
      length: 2,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.fromLTRB(14, 12, 14, 4), child: Row(children: [
          const Icon(Icons.calendar_today, size: 15, color: Color(0xFF1769AA)),
          const SizedBox(width: 7),
          Text(widget.forecast.scheduledStart.toLocal().toString().substring(0, 16), style: const TextStyle(fontSize: 12, color: Color(0xFF667788))),
        ])),
        const TabBar(tabs: [Tab(text: 'Pronóstico'), Tab(text: 'Enfrentamientos')]),
        SizedBox(height: 440, child: TabBarView(children: [_predictionTab(), _headToHeadTab()])),
      ]),
    ),
  );
}
