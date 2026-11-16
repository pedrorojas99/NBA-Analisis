import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class TeamStatsScreen extends StatefulWidget {
  const TeamStatsScreen({super.key});

  @override
  State<TeamStatsScreen> createState() => _TeamStatsScreenState();
}

class _TeamStatsScreenState extends State<TeamStatsScreen> {
  List<Map<String, dynamic>> teams = [];
  Map<String, dynamic>? selectedTeam;
  Map<String, dynamic>? summary;
  List<Map<String, dynamic>> games = [];
  String search = '';
  bool loading = true;
  String? error;

  @override
  void initState() {
    super.initState();
    _loadTeams();
  }

  Future<Map<String, dynamic>> _request(Map<String, dynamic> body) async {
    final response = await Supabase.instance.client.functions.invoke('nba-public-data', body: body);
    if (response.status < 200 || response.status >= 300 || response.data is! Map) {
      throw Exception('No se pudieron cargar los datos de equipos (HTTP ${response.status}).');
    }
    final data = Map<String, dynamic>.from(response.data as Map);
    if (data['ok'] != true) throw Exception((data['error'] ?? 'Respuesta inválida').toString());
    return data;
  }

  Future<void> _loadTeams() async {
    setState(() { loading = true; error = null; });
    try {
      final data = await _request({'action': 'team_stats'});
      final rows = (data['teams'] as List? ?? []).whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e)).toList();
      if (!mounted) return;
      setState(() { teams = rows; loading = false; });
      if (rows.isNotEmpty) await _selectTeam(rows.first);
    } catch (e) {
      if (!mounted) return;
      setState(() { error = e.toString(); loading = false; });
    }
  }

  Future<void> _selectTeam(Map<String, dynamic> team) async {
    setState(() { selectedTeam = team; loading = true; error = null; });
    try {
      final data = await _request({'action': 'team_stats', 'team_id': team['id']});
      if (!mounted) return;
      setState(() {
        selectedTeam = Map<String, dynamic>.from(data['team'] as Map);
        summary = data['summary'] is Map ? Map<String, dynamic>.from(data['summary']) : null;
        games = (data['recent_games'] as List? ?? []).whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e)).toList();
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { error = e.toString(); loading = false; });
    }
  }

  String _fmt(dynamic value) => value == null ? '—' : value.toString();
  String _date(dynamic value) {
    final parsed = DateTime.tryParse((value ?? '').toString());
    if (parsed == null) return 'Fecha —';
    final d = parsed.toLocal();
    return '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
  }

  Widget _logo(String? url, {double size = 46}) => SizedBox(
    width: size, height: size,
    child: url == null || url.isEmpty
      ? Icon(Icons.sports_basketball, size: size * .7, color: const Color(0xFFEF6C35))
      : Image.network(url, fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => Icon(Icons.sports_basketball, size: size * .7, color: const Color(0xFFEF6C35))),
  );

  @override
  Widget build(BuildContext context) {
    final filtered = teams.where((t) =>
      ('${t['display_name']} ${t['abbreviation']} ${t['city'] ?? ''}')
        .toLowerCase().contains(search.toLowerCase())).toList();
    return RefreshIndicator(
      onRefresh: _loadTeams,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Buscar equipos NBA', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 6),
        const Text('Busca cualquier franquicia y consulta su balance, puntos, diferencia y últimos resultados disponibles.'),
        const SizedBox(height: 14),
        TextField(
          decoration: const InputDecoration(
            labelText: 'Buscar equipo', hintText: 'Ej. Celtics, Lakers, Rockets',
            prefixIcon: Icon(Icons.search), border: OutlineInputBorder(), isDense: true,
          ),
          onChanged: (value) => setState(() => search = value),
        ),
        if (search.trim().isNotEmpty)
          Card(child: Column(children: [
            ...filtered.take(8).map((team) => ListTile(
              leading: _logo(team['logo_url']?.toString(), size: 38),
              title: Text(team['display_name']?.toString() ?? 'Equipo'),
              subtitle: Text(team['abbreviation']?.toString() ?? ''),
              onTap: () { FocusScope.of(context).unfocus(); setState(() => search = ''); _selectTeam(team); },
            )),
            if (filtered.isEmpty) const ListTile(title: Text('No se encontraron equipos')),
          ])),
        const SizedBox(height: 12),
        if (loading) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
        if (error != null) Card(child: Padding(padding: const EdgeInsets.all(14), child: Text(error!))),
        if (!loading && selectedTeam != null) ...[
          Card(child: Padding(padding: const EdgeInsets.all(16), child: Row(children: [
            _logo(selectedTeam!['logo_url']?.toString(), size: 68),
            const SizedBox(width: 14),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(selectedTeam!['display_name']?.toString() ?? 'Equipo', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900)),
              Text('${selectedTeam!['city'] ?? ''} · ${selectedTeam!['abbreviation'] ?? ''}'),
              Text('Historial que existe en la base de datos', style: Theme.of(context).textTheme.bodySmall),
            ])),
          ]))),
          if (summary != null) ...[
            GridView.count(
              crossAxisCount: 2, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
              childAspectRatio: 1.75, crossAxisSpacing: 8, mainAxisSpacing: 8,
              children: [
                _metric('BALANCE', '${summary!['wins'] ?? 0}-${summary!['losses'] ?? 0}'),
                _metric('VICTORIAS', '${_fmt(summary!['win_pct'])}%'),
                _metric('PUNTOS A FAVOR', _fmt(summary!['points_for'])),
                _metric('PUNTOS EN CONTRA', _fmt(summary!['points_against'])),
                _metric('DIFERENCIA', _fmt(summary!['point_diff'])),
                _metric('ÚLTIMOS 10', '${summary!['last10_wins'] ?? 0}-${summary!['last10_losses'] ?? 0}'),
              ],
            ),
            const SizedBox(height: 8),
            Text('Últimos partidos', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
            if (games.isEmpty) const Card(child: Padding(padding: EdgeInsets.all(14), child: Text('Aún no hay resultados históricos disponibles para este equipo.'))),
            ...games.map((game) => Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                leading: _logo(game['opponent_logo_url']?.toString(), size: 42),
                title: Text('${selectedTeam!['abbreviation']} ${game['team_score']} - ${game['opponent_score']} ${game['opponent']}',
                  style: const TextStyle(fontWeight: FontWeight.bold)),
                subtitle: Text('${_date(game['date'])} · ${game['home_away']}'),
                trailing: Text(game['won'] == true ? 'W' : 'L',
                  style: TextStyle(fontWeight: FontWeight.w900, color: game['won'] == true ? const Color(0xFF16845B) : const Color(0xFFD45A45))),
              ),
            )),
          ],
        ],
      ]),
    );
  }

  Widget _metric(String label, String value) => Card(
    color: const Color(0xFFF0F5FA),
    child: Padding(padding: const EdgeInsets.all(10), child: Column(
      mainAxisAlignment: MainAxisAlignment.center, children: [
        Text(value, style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
        Text(label, textAlign: TextAlign.center, style: const TextStyle(fontSize: 10, color: Color(0xFF526477), fontWeight: FontWeight.bold)),
      ],
    )),
  );
}
