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

class NbaTeamErrorSummary {
  final String teamId;
  final String team;
  final String abbreviation;
  final int gamesEvaluated;
  final int homeGames;
  final int awayGames;
  final double winnerAccuracyPct;
  final double meanPredictedPoints;
  final double meanActualPoints;
  final double pointsMae;
  final double pointsBias;
  final double opponentPointsMae;
  final double marginMae;

  const NbaTeamErrorSummary({
    required this.teamId, required this.team, required this.abbreviation,
    required this.gamesEvaluated, required this.homeGames, required this.awayGames,
    required this.winnerAccuracyPct, required this.meanPredictedPoints,
    required this.meanActualPoints, required this.pointsMae, required this.pointsBias,
    required this.opponentPointsMae, required this.marginMae,
  });

  factory NbaTeamErrorSummary.fromJson(Map<String, dynamic> json) => NbaTeamErrorSummary(
    teamId: (json['team_id'] ?? '').toString(),
    team: (json['team'] ?? 'Equipo').toString(),
    abbreviation: (json['abbreviation'] ?? '').toString(),
    gamesEvaluated: (json['games_evaluated'] as num?)?.toInt() ?? 0,
    homeGames: (json['home_games'] as num?)?.toInt() ?? 0,
    awayGames: (json['away_games'] as num?)?.toInt() ?? 0,
    winnerAccuracyPct: (json['winner_accuracy_pct'] as num?)?.toDouble() ?? 0,
    meanPredictedPoints: (json['mean_predicted_points'] as num?)?.toDouble() ?? 0,
    meanActualPoints: (json['mean_actual_points'] as num?)?.toDouble() ?? 0,
    pointsMae: (json['points_mae'] as num?)?.toDouble() ?? 0,
    pointsBias: (json['points_bias'] as num?)?.toDouble() ?? 0,
    opponentPointsMae: (json['opponent_points_mae'] as num?)?.toDouble() ?? 0,
    marginMae: (json['margin_mae'] as num?)?.toDouble() ?? 0,
  );
}

class NbaPredictionHistoryData {
  final List<NbaStoredPrediction> forecasts;
  final int evaluatedCount;
  final int pendingCount;
  final List<NbaTeamErrorSummary> teamAnalysis;
  final String? previousSlateDate;
  final List<NbaStoredPrediction> previousSlateGames;
  final int previousSlateWinnerCorrect;
  final double? previousSlateWinnerAccuracyPct;
  final double? previousSlateAverageScoreError;
  final double? previousSlateAverageMarginError;

  const NbaPredictionHistoryData({
    required this.forecasts,
    required this.evaluatedCount,
    required this.pendingCount,
    required this.teamAnalysis,
    required this.previousSlateDate,
    required this.previousSlateGames,
    required this.previousSlateWinnerCorrect,
    required this.previousSlateWinnerAccuracyPct,
    required this.previousSlateAverageScoreError,
    required this.previousSlateAverageMarginError,
  });

  factory NbaPredictionHistoryData.fromJson(Map<String, dynamic> json) {
    final meta = Map<String, dynamic>.from(json['meta'] as Map? ?? {});
    final previousSlate = json['previous_slate'] is Map
        ? Map<String, dynamic>.from(json['previous_slate'] as Map) : null;
    final summary = Map<String, dynamic>.from(previousSlate?['summary'] as Map? ?? {});
    return NbaPredictionHistoryData(
      forecasts: (json['forecasts'] as List? ?? [])
          .whereType<Map>()
          .map((row) => NbaStoredPrediction.fromJson(Map<String, dynamic>.from(row)))
          .toList(),
      evaluatedCount: (meta['evaluated_predictions'] as num?)?.toInt() ?? 0,
      pendingCount: (meta['pending_evaluations'] as num?)?.toInt() ?? 0,
      teamAnalysis: (json['team_analysis'] as List? ?? [])
          .whereType<Map>()
          .map((row) => NbaTeamErrorSummary.fromJson(Map<String, dynamic>.from(row)))
          .toList(),
      previousSlateDate: previousSlate?['date']?.toString(),
      previousSlateGames: (previousSlate?['games'] as List? ?? [])
          .whereType<Map>()
          .map((row) => NbaStoredPrediction.fromJson(Map<String, dynamic>.from(row)))
          .toList(),
      previousSlateWinnerCorrect: (summary['winner_correct'] as num?)?.toInt() ?? 0,
      previousSlateWinnerAccuracyPct: (summary['winner_accuracy_pct'] as num?)?.toDouble(),
      previousSlateAverageScoreError: (summary['average_score_error'] as num?)?.toDouble(),
      previousSlateAverageMarginError: (summary['average_margin_error'] as num?)?.toDouble(),
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
