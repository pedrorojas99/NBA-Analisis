class PlayerForecast {
  final String player;
  final double points;
  final double rebounds;
  final double assists;

  const PlayerForecast({
    required this.player,
    required this.points,
    required this.rebounds,
    required this.assists,
  });

  Map<String, dynamic> toJson() => {
    'player': player, 'points': points, 'rebounds': rebounds, 'assists': assists,
  };

  factory PlayerForecast.fromJson(Map<String, dynamic> json) => PlayerForecast(
    player: json['player'] as String,
    points: (json['points'] as num).toDouble(),
    rebounds: (json['rebounds'] as num).toDouble(),
    assists: (json['assists'] as num).toDouble(),
  );
}

class Prediction {
  // Immutable forecast snapshot: actual results are stored separately.
  final String id;
  final DateTime createdAt;
  final DateTime gameDate;
  final String homeTeam;
  final String awayTeam;
  final String predictedWinner;
  final double homeScore;
  final double awayScore;
  final double homeWinProbability;
  final String modelVersion;
  final List<PlayerForecast> playerForecasts;
  final int? actualHomeScore;
  final int? actualAwayScore;
  final String? actualWinner;
  final DateTime? settledAt;

  const Prediction({
    required this.id,
    required this.createdAt,
    required this.gameDate,
    required this.homeTeam,
    required this.awayTeam,
    required this.predictedWinner,
    required this.homeScore,
    required this.awayScore,
    required this.homeWinProbability,
    required this.modelVersion,
    this.playerForecasts = const [],
    this.actualHomeScore,
    this.actualAwayScore,
    this.actualWinner,
    this.settledAt,
  });

  bool get isSettled => actualHomeScore != null && actualAwayScore != null;

  Prediction settle(int home, int away) => Prediction(
    id: id, createdAt: createdAt, gameDate: gameDate, homeTeam: homeTeam,
    awayTeam: awayTeam, predictedWinner: predictedWinner, homeScore: homeScore,
    awayScore: awayScore, homeWinProbability: homeWinProbability,
    modelVersion: modelVersion, playerForecasts: playerForecasts,
    actualHomeScore: home, actualAwayScore: away,
    actualWinner: home > away ? homeTeam : (away > home ? awayTeam : 'Empate'),
    settledAt: DateTime.now(),
  );

  Map<String, dynamic> toJson() => {
    'id': id, 'createdAt': createdAt.toIso8601String(),
    'gameDate': gameDate.toIso8601String(), 'homeTeam': homeTeam,
    'awayTeam': awayTeam, 'predictedWinner': predictedWinner,
    'homeScore': homeScore, 'awayScore': awayScore,
    'homeWinProbability': homeWinProbability, 'modelVersion': modelVersion,
    'playerForecasts': playerForecasts.map((p) => p.toJson()).toList(),
    'actualHomeScore': actualHomeScore, 'actualAwayScore': actualAwayScore,
    'actualWinner': actualWinner, 'settledAt': settledAt?.toIso8601String(),
  };

  factory Prediction.fromJson(Map<String, dynamic> j) => Prediction(
    id: j['id'], createdAt: DateTime.parse(j['createdAt']),
    gameDate: DateTime.parse(j['gameDate']), homeTeam: j['homeTeam'],
    awayTeam: j['awayTeam'], predictedWinner: j['predictedWinner'],
    homeScore: (j['homeScore'] as num).toDouble(),
    awayScore: (j['awayScore'] as num).toDouble(),
    homeWinProbability: (j['homeWinProbability'] as num).toDouble(),
    modelVersion: j['modelVersion'],
    playerForecasts: (j['playerForecasts'] as List? ?? [])
        .map((e) => PlayerForecast.fromJson(Map<String, dynamic>.from(e))).toList(),
    actualHomeScore: j['actualHomeScore'],
    actualAwayScore: j['actualAwayScore'], actualWinner: j['actualWinner'],
    settledAt: j['settledAt'] == null ? null : DateTime.parse(j['settledAt']),
  );
}
