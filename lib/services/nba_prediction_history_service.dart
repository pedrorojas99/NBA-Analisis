import 'package:supabase_flutter/supabase_flutter.dart';

class NbaStoredPrediction {
  final String id;
  final String gameId;
  final DateTime createdAt;
  final DateTime? scheduledStart;
  final String homeTeam;
  final String awayTeam;
  final String predictedWinner;
  final double predictedHomeScore;
  final double predictedAwayScore;
  final double homeWinProbability;
  final String modelVersion;
  final Map<String, dynamic>? actual;
  final Map<String, dynamic>? errorMetrics;

  const NbaStoredPrediction({
    required this.id,
    required this.gameId,
    required this.createdAt,
    required this.scheduledStart,
    required this.homeTeam,
    required this.awayTeam,
    required this.predictedWinner,
    required this.predictedHomeScore,
    required this.predictedAwayScore,
    required this.homeWinProbability,
    required this.modelVersion,
    required this.actual,
    required this.errorMetrics,
  });

  bool get isEvaluated => actual != null && errorMetrics != null;

  factory NbaStoredPrediction.fromJson(Map<String, dynamic> json) {
    final actualValue = json['actual'];
    final metricsValue = json['error_metrics'];
    return NbaStoredPrediction(
      id: json['id'].toString(),
      gameId: json['game_id'].toString(),
      createdAt: DateTime.parse(json['created_at'].toString()),
      scheduledStart: json['scheduled_start'] == null
          ? null : DateTime.parse(json['scheduled_start'].toString()),
      homeTeam: (json['home_team'] ?? 'Local').toString(),
      awayTeam: (json['away_team'] ?? 'Visitante').toString(),
      predictedWinner: (json['predicted_winner'] ?? '—').toString(),
      predictedHomeScore: (json['predicted_home_score'] as num?)?.toDouble() ?? 0,
      predictedAwayScore: (json['predicted_away_score'] as num?)?.toDouble() ?? 0,
      homeWinProbability: (json['home_win_probability'] as num?)?.toDouble() ?? 0,
      modelVersion: (json['model_version'] ?? 'unknown').toString(),
      actual: actualValue is Map ? Map<String, dynamic>.from(actualValue) : null,
      errorMetrics: metricsValue is Map ? Map<String, dynamic>.from(metricsValue) : null,
    );
  }
}

class NbaPredictionHistoryData {
  final List<NbaStoredPrediction> forecasts;
  final int evaluatedCount;
  final int pendingCount;

  const NbaPredictionHistoryData({
    required this.forecasts,
    required this.evaluatedCount,
    required this.pendingCount,
  });

  factory NbaPredictionHistoryData.fromJson(Map<String, dynamic> json) {
    final meta = Map<String, dynamic>.from(json['meta'] as Map? ?? {});
    return NbaPredictionHistoryData(
      forecasts: (json['forecasts'] as List? ?? [])
          .whereType<Map>()
          .map((row) => NbaStoredPrediction.fromJson(Map<String, dynamic>.from(row)))
          .toList(),
      evaluatedCount: (meta['evaluated_predictions'] as num?)?.toInt() ?? 0,
      pendingCount: (meta['pending_evaluations'] as num?)?.toInt() ?? 0,
    );
  }
}

class NbaPredictionHistoryService {
  Future<NbaPredictionHistoryData> load() async {
    final response = await Supabase.instance.client.functions.invoke(
      'nba-prediction-history',
      body: const {},
    );
    if (response.status < 200 || response.status >= 300) {
      throw Exception('El historial en la nube respondió con código ${response.status}');
    }
    if (response.data is! Map) throw Exception('Respuesta del historial en la nube inválida.');
    final body = Map<String, dynamic>.from(response.data as Map);
    if (body['ok'] != true) {
      throw Exception((body['error'] ?? 'No se pudo cargar el historial.').toString());
    }
    return NbaPredictionHistoryData.fromJson(body);
  }
}
