import 'package:supabase_flutter/supabase_flutter.dart';

class NbaTeam {
  final String id;
  final String name;
  final String abbreviation;

  const NbaTeam({required this.id, required this.name, required this.abbreviation});

  factory NbaTeam.fromJson(Map<String, dynamic> json) => NbaTeam(
    id: json['id'] as String,
    name: (json['display_name'] ?? json['city'] ?? 'Equipo') as String,
    abbreviation: (json['abbreviation'] ?? 'NBA') as String,
  );
}

class NbaGame {
  final String id;
  final DateTime scheduledStart;
  final String status;
  final String? statusDetail;
  final NbaTeam? homeTeam;
  final NbaTeam? awayTeam;
  final Map<String, dynamic>? liveScore;
  final Map<String, dynamic>? result;

  const NbaGame({
    required this.id,
    required this.scheduledStart,
    required this.status,
    this.statusDetail,
    this.homeTeam,
    this.awayTeam,
    this.liveScore,
    this.result,
  });

  factory NbaGame.fromJson(Map<String, dynamic> json) {
    Map<String, dynamic>? optionalMap(dynamic value) =>
        value is Map ? Map<String, dynamic>.from(value) : null;
    final home = optionalMap(json['home_team']);
    final away = optionalMap(json['away_team']);
    return NbaGame(
      id: json['id'] as String,
      scheduledStart: DateTime.parse(json['scheduled_start'] as String),
      status: (json['status'] ?? 'scheduled') as String,
      statusDetail: json['status_detail'] as String?,
      homeTeam: home == null ? null : NbaTeam.fromJson(home),
      awayTeam: away == null ? null : NbaTeam.fromJson(away),
      liveScore: optionalMap(json['live_score']),
      result: optionalMap(json['result']),
    );
  }

  int? _number(dynamic value) => value is num ? value.toInt() : int.tryParse('$value');
  int? get homeScore => result != null
      ? _number(result!['home_score']) : _number(liveScore?['home']);
  int? get awayScore => result != null
      ? _number(result!['away_score']) : _number(liveScore?['away']);
}

class NbaPlayerGameStat {
  final String playerName;
  final String teamAbbreviation;
  final DateTime gameDate;
  final Map<String, dynamic> stats;

  const NbaPlayerGameStat({
    required this.playerName,
    required this.teamAbbreviation,
    required this.gameDate,
    required this.stats,
  });

  factory NbaPlayerGameStat.fromJson(Map<String, dynamic> json) =>
      NbaPlayerGameStat(
        playerName: (json['player_name'] ?? 'Jugador').toString(),
        teamAbbreviation: (json['team_abbreviation'] ?? '').toString(),
        gameDate: DateTime.parse(json['game_date'] as String),
        stats: json['stats'] is Map
            ? Map<String, dynamic>.from(json['stats'] as Map)
            : <String, dynamic>{},
      );

  String value(String key) => (stats[key] ?? '—').toString();
}

class NbaData {
  final DateTime updatedAt;
  final List<NbaGame> games;
  final Map<String, dynamic> meta;
  final List<NbaPlayerGameStat> playerStats;

  const NbaData({required this.updatedAt, required this.games, required this.meta, required this.playerStats});

  factory NbaData.fromJson(Map<String, dynamic> json) => NbaData(
    updatedAt: DateTime.parse(json['updated_at'] as String),
    games: (json['games'] as List? ?? [])
        .map((e) => NbaGame.fromJson(Map<String, dynamic>.from(e as Map))).toList(),
    meta: Map<String, dynamic>.from(json['meta'] as Map? ?? {}),
    playerStats: (json['player_stats'] as List? ?? [])
        .whereType<Map>()
        .map((e) => NbaPlayerGameStat.fromJson(Map<String, dynamic>.from(e)))
        .toList(),
  );
}

class NbaDataService {
  Future<NbaData> load() async {
    final response = await Supabase.instance.client.functions.invoke('nba-public-data');
    if (response.status < 200 || response.status >= 300) {
      throw Exception('El servidor NBA respondió con código ' + response.status.toString());
    }
    if (response.data is! Map) throw Exception('Respuesta NBA inválida.');
    final body = Map<String, dynamic>.from(response.data as Map);
    if (body['ok'] != true) {
      throw Exception((body['error'] ?? 'No se pudieron cargar los partidos.').toString());
    }
    return NbaData.fromJson(body);
  }
}
