import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../services/nba_data_service.dart';
import '../services/nba_prediction_service.dart';
import '../services/nba_player_prediction_service.dart';
import 'matchup_prediction_card.dart';

class GameAnalysisScreen extends StatefulWidget {
  final NbaGame game;
  const GameAnalysisScreen({super.key, required this.game});

  @override
  State<GameAnalysisScreen> createState() => _GameAnalysisScreenState();
}

class _GameAnalysisScreenState extends State<GameAnalysisScreen> {
  NbaForecast? forecast;
  List<NbaPlayerForecast> players = [];
  Map<String, dynamic>? awayStats;
  Map<String, dynamic>? homeStats;
  bool loading = true;
  String? predictionError;
  String? statsError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<Map<String, dynamic>?> _loadTeamStats(String? teamId) async {
    if (teamId == null || teamId.isEmpty) return null;
    final response = await Supabase.instance.client.functions.invoke(
      'nba-public-data',
      body: {'action': 'team_stats', 'team_id': teamId},
    );
    if (response.status < 200 || response.status >= 300 || response.data is! Map) {
      throw Exception('HTTP ${response.status}');
    }
    final data = Map<String, dynamic>.from(response.data as Map);
    if (data['ok'] != true) throw Exception((data['error'] ?? 'Estadísticas no disponibles').toString());
    return data['summary'] is Map ? Map<String, dynamic>.from(data['summary']) : null;
  }

  Future<void> _load() async {
    if (mounted) setState(() { loading = true; predictionError = null; statsError = null; });
    try {
      final data = await NbaPredictionService().load();
      final playerData = await NbaPlayerPredictionService().load();
      if (!mounted) return;
      setState(() {
        final matchingForecasts = data.forecasts.where((f) => f.gameId == widget.game.id).toList();
        forecast = matchingForecasts.isEmpty ? null : matchingForecasts.first;
        players = playerData.forecasts.where((p) => p.gameId == widget.game.id).toList();
      });
    } catch (e) {
      if (mounted) setState(() => predictionError = e.toString());
    }
    try {
      final values = await Future.wait([
        _loadTeamStats(widget.game.awayTeam?.id),
        _loadTeamStats(widget.game.homeTeam?.id),
      ]);
      if (mounted) setState(() { awayStats = values[0]; homeStats = values[1]; });
    } catch (e) {
      if (mounted) setState(() => statsError = e.toString());
    }
    if (mounted) setState(() => loading = false);
  }

  String _value(Map<String, dynamic>? stats, String key, {bool percent = false}) {
    final value = stats?[key];
    if (value == null) return '—';
    if (value is num) return '${value.toStringAsFixed(1)}${percent ? '%' : ''}';
    return value.toString();
  }

  Widget _teamStats(String title, String? abbreviation, Map<String, dynamic>? stats) {
    final rows = <(String, String)>[
      ('Balance', '${stats?['wins'] ?? '—'}-${stats?['losses'] ?? '—'}'),
      ('Victorias', _value(stats, 'win_pct', percent: true)),
      ('Puntos a favor', _value(stats, 'points_for')),
      ('Puntos en contra', _value(stats, 'points_against')),
      ('Diferencia', _value(stats, 'point_diff')),
      ('Últimos 10', '${stats?['last10_wins'] ?? '—'}-${stats?['last10_losses'] ?? '—'}'),
    ];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
          if (abbreviation != null) Text(abbreviation, style: const TextStyle(fontSize: 11, color: Color(0xFF667788))),
          const Divider(height: 14),
          ...rows.map((row) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(children: [
              Expanded(child: Text(row.$1, style: const TextStyle(fontSize: 12))),
              Text(row.$2, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
            ]),
          )),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final game = widget.game;
    return Scaffold(
      appBar: AppBar(title: const Text('Análisis del partido')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(children: [
                  Text(game.scheduledStart.toLocal().toString().substring(0, 16),
                    style: const TextStyle(fontSize: 12, color: Color(0xFF667788))),
                  const SizedBox(height: 10),
                  Text('${game.awayTeam?.name ?? 'Visitante'} vs ${game.homeTeam?.name ?? 'Local'}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
                  const SizedBox(height: 4),
                  const Text('ANÁLISIS PREVIO AL PARTIDO',
                    style: TextStyle(fontSize: 10, letterSpacing: 1, color: Color(0xFF667788))),
                ]),
              ),
            ),
            if (loading) const Padding(
              padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator())),
            if (predictionError != null)
              Card(child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text('No se pudieron cargar las predicciones: $predictionError'),
              )),
            if (!loading && forecast != null)
              MatchupPredictionCard(
                forecast: forecast!,
                homeTeam: game.homeTeam,
                awayTeam: game.awayTeam,
                players: players,
              ),
            if (!loading && forecast == null && predictionError == null)
              const Card(child: Padding(
                padding: EdgeInsets.all(12),
                child: Text('El motor todavía no ha generado un pronóstico para este partido. No mostraremos un marcador inventado.'),
              )),
            const Padding(
              padding: EdgeInsets.fromLTRB(4, 10, 4, 6),
              child: Text('ESTADÍSTICAS PRINCIPALES DE LOS EQUIPOS',
                style: TextStyle(fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
            ),
            if (statsError != null)
              Card(child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text('No se pudieron cargar las estadísticas de equipo: $statsError'),
              )),
            if (!loading) ...[
              _teamStats(game.awayTeam?.name ?? 'Visitante', game.awayTeam?.abbreviation, awayStats),
              _teamStats(game.homeTeam?.name ?? 'Local', game.homeTeam?.abbreviation, homeStats),
            ],
            const Padding(
              padding: EdgeInsets.all(8),
              child: Text('Las estadísticas y predicciones se muestran únicamente cuando existen datos históricos suficientes y confirmados.',
                style: TextStyle(fontSize: 11, color: Color(0xFF667788))),
            ),
          ],
        ),
      ),
    );
  }
}
