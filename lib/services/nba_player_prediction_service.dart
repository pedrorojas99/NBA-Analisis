import 'package:supabase_flutter/supabase_flutter.dart';

class NbaPlayerForecast {
  final String gameId;
  final DateTime scheduledStart;
  final String playerId;
  final String playerName;
  final String teamName;
  final String teamAbbreviation;
  final String? position;
  final double points;
  final double rebounds;
  final double assists;
  final double threes;
  final double minutes;
  final int sampleGames;
  final bool injuryClear;

  const NbaPlayerForecast({
    required this.gameId,
    required this.scheduledStart,
    required this.playerId,
    required this.playerName,
    required this.teamName,
    required this.teamAbbreviation,
    this.position,
    required this.points,
    required this.rebounds,
    required this.assists,
    required this.threes,
    required this.minutes,
    required this.sampleGames,
    this.injuryClear = false,
  });

  factory NbaPlayerForecast.fromJson(Map<String, dynamic> json) {
    double number(String key) => (json[key] as num?)?.toDouble() ?? 0;
    return NbaPlayerForecast(
      gameId: (json['game_id'] ?? '').toString(),
      scheduledStart: DateTime.tryParse((json['scheduled_start'] ?? '').toString()) ?? DateTime.now(),
      playerId: (json['player_id'] ?? '').toString(),
      playerName: (json['player_name'] ?? 'Jugador').toString(),
      teamName: (json['team_name'] ?? '').toString(),
      teamAbbreviation: (json['team_abbreviation'] ?? '').toString(),
      position: json['position']?.toString(),
      points: number('predicted_points'),
      rebounds: number('predicted_rebounds'),
      assists: number('predicted_assists'),
      threes: number('predicted_threes'),
      minutes: number('predicted_minutes'),
      sampleGames: (json['sample_games'] as num?)?.toInt() ?? 0,
      injuryClear: json['injury_clear'] == true,
    );
  }
}

class NbaPlayerPredictionData {
  final String modelVersion;
  final String slateDate;
  final String slateStatus;
  final List<NbaPlayerForecast> forecasts;
  final Map<String, dynamic> meta;

  const NbaPlayerPredictionData({
    required this.modelVersion,
    required this.slateDate,
    required this.slateStatus,
    required this.forecasts,
    required this.meta,
  });

  factory NbaPlayerPredictionData.fromJson(Map<String, dynamic> json) {
    final model = Map<String, dynamic>.from(json['model'] as Map? ?? {});
    return NbaPlayerPredictionData(
      modelVersion: (model['version'] ?? 'unknown').toString(),
      slateDate: (json['slate_date'] ?? '').toString(),
      slateStatus: (json['slate_status'] ?? 'unknown').toString(),
      forecasts: (json['player_forecasts'] as List? ?? [])
          .whereType<Map>()
          .map((item) => NbaPlayerForecast.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      meta: Map<String, dynamic>.from(json['meta'] as Map? ?? {}),
    );
  }
}

class NbaPlayerPredictionService {
  Future<NbaPlayerPredictionData> load() async {
    final response = await Supabase.instance.client.functions.invoke(
      'nba-player-predictions',
      // The Android client is read-only; scheduled Supabase automation owns all writes.
      body: const {'persist': false},
    );
    if (response.status < 200 || response.status >= 300) {
      throw Exception('El motor de jugadores respondió con código ${response.status}');
    }
    if (response.data is! Map) throw Exception('Respuesta de predicciones individuales inválida.');
    final body = Map<String, dynamic>.from(response.data as Map);
    if (body['ok'] != true) {
      throw Exception((body['error'] ?? 'No se pudieron cargar las predicciones de jugadores.').toString());
    }
    return NbaPlayerPredictionData.fromJson(body);
  }
}
