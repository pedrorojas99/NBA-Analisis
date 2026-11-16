import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class PlayerStatsScreen extends StatefulWidget {
  const PlayerStatsScreen({super.key});

  @override
  State<PlayerStatsScreen> createState() => _PlayerStatsScreenState();
}

class _PlayerStatsScreenState extends State<PlayerStatsScreen> {
  List<Map<String, dynamic>> players = [];
  List<Map<String, dynamic>> games = [];
  List<int> seasons = [];
  String? selectedPlayerId;
  int? selectedSeason;
  String search = '';
  bool showPlayerSuggestions = false;
  late final TextEditingController searchController = TextEditingController();
  bool loading = true;
  String? error;

  @override
  void dispose() {
    searchController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({String? playerId}) async {
    if (mounted) setState(() { loading = true; error = null; });
    try {
      final response = await Supabase.instance.client.functions.invoke(
        'nba-public-data',
        body: {
          'action': 'player_stats',
          if (playerId != null) 'player_id': playerId,
        },
      );
      if (response.status < 200 || response.status >= 300 || response.data is! Map) {
        throw Exception('No se pudieron cargar las estadísticas (HTTP ${response.status}).');
      }
      final data = Map<String, dynamic>.from(response.data as Map);
      if (data['ok'] != true) throw Exception((data['error'] ?? 'Respuesta inválida').toString());
      final nextPlayers = (data['players'] as List? ?? [])
          .whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      final nextGames = (data['player_games'] as List? ?? [])
          .whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      final nextSeasons = (data['seasons'] as List? ?? [])
          .whereType<num>().map((e) => e.toInt()).toList();
      if (!mounted) return;
      final nextSelected = playerId ?? selectedPlayerId ??
          (nextPlayers.isEmpty ? null : nextPlayers.first['id']?.toString());
      setState(() {
        players = nextPlayers;
        games = nextGames;
        seasons = nextSeasons;
        selectedPlayerId = nextSelected;
        if (selectedSeason != null && !nextSeasons.contains(selectedSeason)) selectedSeason = null;
        loading = false;
      });
      if (playerId == null && nextSelected != null) {
        await _load(playerId: nextSelected);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() { error = e.toString(); loading = false; });
    }
  }

  Map<String, dynamic> _values(Map<String, dynamic> stats) {
    final categories = stats['categories'];
    if (categories is List && categories.isNotEmpty && categories.first is Map) {
      final values = (categories.first as Map)['values'];
      if (values is Map) return Map<String, dynamic>.from(values);
    }
    return stats;
  }

  double? _number(dynamic value) {
    if (value == null) return null;
    final text = value.toString().trim();
    if (text.isEmpty || text == '—') return null;
    final first = text.split('-').first.trim();
    return double.tryParse(first);
  }

  List<double> _pair(dynamic value) {
    final parts = value?.toString().split('-') ?? [];
    if (parts.length != 2) return [];
    final made = double.tryParse(parts[0].trim());
    final attempts = double.tryParse(parts[1].trim());
    if (made == null || attempts == null) return [];
    return [made, attempts];
  }

  double? _average(String key, List<Map<String, dynamic>> rows) {
    final values = rows.map((g) => _number(_values(Map<String, dynamic>.from(g['stats'] as Map? ?? {}))[key]))
        .whereType<double>().toList();
    if (values.isEmpty) return null;
    return values.reduce((a, b) => a + b) / values.length;
  }

  String _fmt(double? value) => value == null ? '—' : value.toStringAsFixed(1);

  String _shootingPct(String key, List<Map<String, dynamic>> rows) {
    var made = 0.0;
    var attempts = 0.0;
    for (final game in rows) {
      final pair = _pair(_values(Map<String, dynamic>.from(game['stats'] as Map? ?? {}))[key]);
      if (pair.length == 2) { made += pair[0]; attempts += pair[1]; }
    }
    return attempts == 0 ? '—' : '${(100 * made / attempts).toStringAsFixed(1)}%';
  }

  @override
  Widget build(BuildContext context) {
    final filteredPlayers = players.where((p) =>
      (p['name'] ?? '').toString().toLowerCase().contains(search.toLowerCase())).toList();
    final selectedMatches = players.where((p) => p['id'] == selectedPlayerId).toList();
    final selected = selectedMatches.isEmpty ? null : selectedMatches.first;
    final seasonGames = selectedSeason == null
        ? games
        : games.where((g) => g['season_start_year'] == selectedSeason).toList();
    return RefreshIndicator(
      onRefresh: () => _load(playerId: selectedPlayerId),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Estadísticas de jugadores',
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
          const SizedBox(height: 6),
          const Text('Consulta promedios calculados a partir de los partidos que ya tienen estadísticas registradas.'),
          const SizedBox(height: 16),
          TextField(
            controller: searchController,
            decoration: const InputDecoration(
              labelText: 'Buscar jugador', hintText: 'Ej. Leb',
              prefixIcon: Icon(Icons.search), border: OutlineInputBorder(), isDense: true,
            ),
            onChanged: (value) => setState(() {
              search = value;
              showPlayerSuggestions = value.trim().isNotEmpty;
            }),
          ),
          if (showPlayerSuggestions && search.trim().isNotEmpty)
            Card(
              margin: const EdgeInsets.only(top: 4),
              child: Column(
                children: [
                  ...filteredPlayers.take(8).map((player) => ListTile(
                    dense: true,
                    leading: const Icon(Icons.person_search),
                    title: Text(player['name']?.toString() ?? 'Jugador'),
                    subtitle: Text('${player['position'] ?? 'Posición —'} · ${player['games_count'] ?? 0} partidos'),
                    onTap: () {
                      final id = player['id'].toString();
                      final name = player['name']?.toString() ?? '';
                      setState(() {
                        selectedPlayerId = id;
                        selectedSeason = null;
                        search = name;
                        searchController.text = name;
                        showPlayerSuggestions = false;
                      });
                      _load(playerId: id);
                    },
                  )),
                  if (filteredPlayers.isEmpty)
                    const ListTile(title: Text('No se encontraron jugadores')),
                ],
              ),
            ),
          if (selected != null && !showPlayerSuggestions)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Jugador seleccionado: ${selected['name']}',
                style: Theme.of(context).textTheme.bodySmall),
            ),
          const SizedBox(height: 10),
          if (seasons.isNotEmpty)
            DropdownButtonFormField<int?>(
              value: selectedSeason,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Temporada', border: OutlineInputBorder()),
              items: [
                const DropdownMenuItem<int?>(value: null, child: Text('Todas las temporadas disponibles')),
                ...seasons.map((s) => DropdownMenuItem<int?>(value: s, child: Text('${s}-${(s + 1).toString().substring(2)}'))),
              ],
              onChanged: (value) => setState(() => selectedSeason = value),
            ),
          const SizedBox(height: 14),
          if (loading) const Center(child: Padding(
            padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
          if (error != null) Card(child: Padding(
            padding: const EdgeInsets.all(14),
            child: Text(error!, style: const TextStyle(color: Colors.orangeAccent)))),
          if (!loading && selected != null) ...[
            Card(child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(selected['name']?.toString() ?? 'Jugador',
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text('${selected['position'] ?? 'Posición —'} · ${selected['games_count'] ?? 0} partidos con datos en la base'),
                const SizedBox(height: 8),
                const Text('Cobertura limitada: los promedios representan únicamente los partidos recopilados, no necesariamente toda la temporada.',
                  style: TextStyle(fontSize: 12)),
              ]),
            )),
            if (seasonGames.isNotEmpty) ...[
              Text('Promedios · ${seasonGames.length} partidos',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              GridView.count(
                crossAxisCount: 3, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
                childAspectRatio: 1.45, crossAxisSpacing: 8, mainAxisSpacing: 8,
                children: [
                  _metric('PTS', _fmt(_average('PTS', seasonGames))),
                  _metric('REB', _fmt(_average('REB', seasonGames))),
                  _metric('AST', _fmt(_average('AST', seasonGames))),
                  _metric('STL', _fmt(_average('STL', seasonGames))),
                  _metric('BLK', _fmt(_average('BLK', seasonGames))),
                  _metric('3PM', _fmt(_average('3PT', seasonGames))),
                  _metric('MIN', _fmt(_average('MIN', seasonGames))),
                ],
              ),
              const SizedBox(height: 8),
              Card(child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
                  _shooting('FG%', _shootingPct('FG', seasonGames)),
                  _shooting('3P%', _shootingPct('3PT', seasonGames)),
                  _shooting('FT%', _shootingPct('FT', seasonGames)),
                ]),
              )),
            ] else if (!loading) Card(child: Padding(
              padding: const EdgeInsets.all(16),
              child: Text('No hay estadísticas registradas para este jugador en ${selectedSeason == null ? 'el período disponible' : 'la temporada seleccionada'}.'),
            )),
            const SizedBox(height: 12),
            Text('Partidos recientes',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
            if (seasonGames.isEmpty) const Padding(
              padding: EdgeInsets.all(12), child: Text('No hay partidos para mostrar.')),
            ...seasonGames.map((game) {
              final stats = _values(Map<String, dynamic>.from(game['stats'] as Map? ?? {}));
              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: Padding(padding: const EdgeInsets.all(12), child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      Text('${game['team_abbreviation'] ?? ''} vs ${game['opponent_abbreviation'] ?? '—'}',
                        style: const TextStyle(fontWeight: FontWeight.bold)),
                      Text((game['game_date'] ?? '').toString().length >= 10
                        ? (game['game_date'] as String).substring(0, 10) : 'Fecha —',
                        style: Theme.of(context).textTheme.bodySmall),
                    ]),
                    const SizedBox(height: 8),
                    Wrap(spacing: 14, runSpacing: 6, children: [
                      _detail('PTS', stats['PTS']), _detail('REB', stats['REB']),
                      _detail('AST', stats['AST']), _detail('3PT', stats['3PT']),
                      _detail('FG', stats['FG']), _detail('MIN', stats['MIN']),
                    ]),
                  ],
                )),
              );
            }),
          ],
          if (!loading && players.isEmpty && error == null)
            const Card(child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Todavía no hay jugadores con estadísticas registradas.'),
            )),
        ],
      ),
    );
  }

  Widget _metric(String label, String value) => Card(
    child: Padding(padding: const EdgeInsets.all(8), child: Column(
      mainAxisAlignment: MainAxisAlignment.center, children: [
        Text(value, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w900)),
        Text(label, style: const TextStyle(fontSize: 11)),
      ],
    )),
  );

  Widget _shooting(String label, String value) => Column(children: [
    Text(value, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
    Text(label, style: const TextStyle(fontSize: 12)),
  ]);

  Widget _detail(String label, dynamic value) => Text('$label: ${value ?? '—'}',
    style: const TextStyle(fontSize: 12));
}
