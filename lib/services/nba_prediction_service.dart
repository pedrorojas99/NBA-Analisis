import 'package:supabase_flutter/supabase_flutter.dart';

class NbaForecast {
  final String gameId;
  final DateTime scheduledStart;
  final String homeTeam;
  final String awayTeam;
  final String predictedWinner;
  final double predictedHomeScore;
  final double predictedAwayScore;
  final double homeWinProbability;
  final double awayWinProbability;
  final String homeRecentRecord;
  final String awayRecentRecord;
  final int homeSample;
  final int awaySample;

  const NbaForecast({
    required this.gameId, required this.scheduledStart,
    required this.homeTeam, required this.awayTeam,
    required this.predictedWinner, required this.predictedHomeScore,
    required this.predictedAwayScore, required this.homeWinProbability,
    required this.awayWinProbability, required this.homeRecentRecord,
    required this.awayRecentRecord, required this.homeSample,
    required this.awaySample,
  });

  factory NbaForecast.fromJson(Map<String, dynamic> json) => NbaForecast(
    gameId: json['game_id'] as String,
    scheduledStart: DateTime.parse(json['scheduled_start'] as String),
    homeTeam: (json['home_team'] ?? 'Local').toString(),
    awayTeam: (json['away_team'] ?? 'Visitante').toString(),
    predictedWinner: (json['predicted_winner'] ?? '—').toString(),
    predictedHomeScore: (json['predicted_home_score'] as num).toDouble(),
    predictedAwayScore: (json['predicted_away_score'] as num).toDouble(),
    homeWinProbability: (json['home_win_probability'] as num).toDouble(),
    awayWinProbability: (json['away_win_probability'] as num).toDouble(),
    homeRecentRecord: (json['home_recent_record'] ?? '—').toString(),
    awayRecentRecord: (json['away_recent_record'] ?? '—').toString(),
    homeSample: (json['home_sample'] as num?)?.toInt() ?? 0,
    awaySample: (json['away_sample'] as num?)?.toInt() ?? 0,
  );
}

class NbaPredictionData {
  final String modelVersion;
  final String modelStatus;
  final String modelDescription;
  final List<NbaForecast> forecasts;
  final Map<String, dynamic> meta;

  const NbaPredictionData({
    required this.modelVersion, required this.modelStatus,
    required this.modelDescription, required this.forecasts,
    required this.meta,
  });

  factory NbaPredictionData.fromJson(Map<String, dynamic> json) {
    final model = Map<String, dynamic>.from(json['model'] as Map? ?? {});
    return NbaPredictionData(
      modelVersion: (model['version'] ?? 'unknown').toString(),
      modelStatus: (model['status'] ?? 'experimental').toString(),
      modelDescription: (model['description'] ?? '').toString(),
      forecasts: (json['forecasts'] as List? ?? [])
          .whereType<Map>()
          .map((e) => NbaForecast.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
      meta: Map<String, dynamic>.from(json['meta'] as Map? ?? {}),
    );
  }
}

class NbaPredictionService {
  Future<NbaPredictionData> load() async {
    Object? lastError;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        final response = await Supabase.instance.client.functions.invoke(
          'nba-predictions',
          body: const {'persist': true},
        );
        if (response.status < 200 || response.status >= 300) {
          throw Exception('El motor de predicciones respondió con código ${response.status}');
        }
        if (response.data is! Map) throw Exception('Respuesta del motor de predicciones inválida.');
        final body = Map<String, dynamic>.from(response.data as Map);
        if (body['ok'] != true) {
          throw Exception((body['error'] ?? 'No se pudieron generar los pronósticos.').toString());
        }
        return NbaPredictionData.fromJson(body);
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await Future.delayed(Duration(milliseconds: 700 * (attempt + 1)));
        }
      }
    }
    throw Exception('No se pudo consultar el motor de predicciones después de 3 intentos: $lastError');
  }
}
