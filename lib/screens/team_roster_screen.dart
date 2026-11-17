import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class TeamRosterScreen extends StatefulWidget {
  final String teamId;
  final String teamName;
  final String abbreviation;
  const TeamRosterScreen({super.key, required this.teamId, required this.teamName, required this.abbreviation});

  @override
  State<TeamRosterScreen> createState() => _TeamRosterScreenState();
}

class _TeamRosterScreenState extends State<TeamRosterScreen> {
  List<Map<String, dynamic>> players = [];
  bool loading = true;
  String? error;
  String? syncedAt;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { loading = true; error = null; });
    try {
      final response = await Supabase.instance.client.functions.invoke(
        'nba-roster-sync',
        body: {'action': 'team_roster', 'team_id': widget.teamId},
      );
      if (response.status < 200 || response.status >= 300 || response.data is! Map) {
        throw Exception('No se pudo cargar la plantilla (HTTP ${response.status}).');
      }
      final data = Map<String, dynamic>.from(response.data as Map);
      if (data['ok'] != true) throw Exception((data['error'] ?? 'Plantilla no disponible').toString());
      if (!mounted) return;
      setState(() {
        players = (data['players'] as List? ?? []).whereType<Map>()
            .map((p) => Map<String, dynamic>.from(p)).toList();
        syncedAt = data['synced_at']?.toString();
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { error = e.toString(); loading = false; });
    }
  }

  String _average(dynamic value) => value is num ? value.toStringAsFixed(1) : '—';

  String _lastUpdated() {
    final date = DateTime.tryParse(syncedAt ?? '');
    if (date == null) return 'Actualización automática cada 12 horas';
    final local = date.toLocal();
    return 'Plantilla sincronizada: ${local.day.toString().padLeft(2, '0')}/${local.month.toString().padLeft(2, '0')}/${local.year} · ${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(widget.teamName, maxLines: 1, overflow: TextOverflow.ellipsis)),
    body: RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          Row(children: [
            Expanded(child: Text('Plantilla actual · ${widget.abbreviation}', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900))),
            IconButton(onPressed: _load, icon: const Icon(Icons.refresh), tooltip: 'Actualizar plantilla'),
          ]),
          Text(_lastUpdated(), style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          Align(alignment: Alignment.centerLeft, child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(color: const Color(0xFFE8F0FA), borderRadius: BorderRadius.circular(20)),
            child: const Text('HISTÓRICO DE CARRERA · TODOS LOS EQUIPOS', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
          )),
          const SizedBox(height: 5),
          const Text('Promedios de temporada regular durante toda la carrera NBA del jugador, sin importar el equipo.', style: TextStyle(fontSize: 11, color: Color(0xFF667788))),
          const SizedBox(height: 12),
          if (loading) const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
          if (error != null) Card(child: Padding(padding: const EdgeInsets.all(14), child: Column(children: [
            Text(error!, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            FilledButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('Reintentar')),
          ]))),
          if (!loading && error == null && players.isEmpty)
            const Card(child: Padding(padding: EdgeInsets.all(16), child: Text('Todavía no hay plantilla sincronizada para este equipo. Vuelve a intentarlo más tarde.'))),
          ...players.map((p) => Card(
            margin: const EdgeInsets.only(bottom: 9),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 11),
              child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                SizedBox(
                  width: 68,
                  child: Column(children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Container(
                        width: 58, height: 58, color: const Color(0xFFF0F4F8),
                        child: p['headshot_url'] is String && (p['headshot_url'] as String).isNotEmpty
                          ? Image.network(p['headshot_url'], fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => const Icon(Icons.person, size: 34, color: Color(0xFF8293A5)))
                          : const Icon(Icons.person, size: 34, color: Color(0xFF8293A5)),
                      ),
                    ),
                    const SizedBox(height: 5),
                    Text(p['name']?.toString() ?? 'Jugador', textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800)),
                    Text(p['position']?.toString() ?? '—', textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 10, color: Color(0xFF667788))),
                    if (p['jersey'] != null) Text('#${p['jersey']}', style: const TextStyle(fontSize: 10, color: Color(0xFF667788))),
                  ]),
                ),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('PROMEDIOS HISTÓRICOS POR PARTIDO', style: TextStyle(fontSize: 9, fontWeight: FontWeight.w800, color: Color(0xFF667788))),
                  const SizedBox(height: 8),
                  Row(children: [
                    _stat('PTS', _average(p['points_avg'])),
                    _stat('REB', _average(p['rebounds_avg'])),
                    _stat('3PT', _average(p['threes_avg'])),
                  ]),
                  const SizedBox(height: 6),
                  Text('${p['games'] ?? 0} partidos de temporada regular en su carrera', style: const TextStyle(fontSize: 10, color: Color(0xFF667788))),
                ])),
              ]),
            ),
          )),
        ],
      ),
    ),
  );

  Widget _stat(String label, String value) => Expanded(child: Container(
    margin: const EdgeInsets.only(right: 5),
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 8),
    decoration: BoxDecoration(color: const Color(0xFFF0F5FA), borderRadius: BorderRadius.circular(8)),
    child: Column(children: [
      Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: Color(0xFF174A7E))),
      Text(label, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Color(0xFF667788))),
    ]),
  ));
}