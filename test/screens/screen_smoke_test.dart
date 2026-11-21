import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:nba_analytics/services/nba_data_service.dart';
import 'package:nba_analytics/services/nba_prediction_service.dart';
import 'package:nba_analytics/screens/home_screen.dart';
import 'package:nba_analytics/screens/search_hub_screen.dart';
import 'package:nba_analytics/screens/player_stats_screen.dart';
import 'package:nba_analytics/screens/team_stats_screen.dart';
import 'package:nba_analytics/screens/team_roster_screen.dart';
import 'package:nba_analytics/screens/game_analysis_screen.dart';
import 'package:nba_analytics/screens/matchup_prediction_card.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('NBA data models parse official team and game payloads', () {
    final game = NbaGame.fromJson({
      'id': 'game-1',
      'scheduled_start': '2026-11-21T18:00:00Z',
      'status': 'scheduled',
      'home_team': {'id': 'team-home', 'display_name': 'Boston Celtics', 'abbreviation': 'BOS'},
      'away_team': {'id': 'team-away', 'display_name': 'New York Knicks', 'abbreviation': 'NYK'},
      'result': null,
      'live_score': null,
    });
    expect(game.homeTeam?.abbreviation, 'BOS');
    expect(game.awayTeam?.abbreviation, 'NYK');
    expect(game.homeScore, isNull);
    expect(game.status, 'scheduled');
  });

  testWidgets('Home screen mounts with the NBA Analytics shell', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: HomeScreen(enableLivePolling: false)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('NBA ANALYTICS'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Search hub exposes player and team tabs', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SearchHubScreen())));
    await tester.pump();
    expect(find.text('Jugadores'), findsOneWidget);
    expect(find.text('Equipos'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Player statistics screen mounts and handles unavailable backend', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PlayerStatsScreen())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Estadísticas de jugadores'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Team statistics screen mounts and handles unavailable backend', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: TeamStatsScreen())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Buscar equipos NBA'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Team roster screen mounts and handles unavailable backend', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: TeamRosterScreen(teamId: 'team-bos', teamName: 'Boston Celtics', abbreviation: 'BOS'),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Boston Celtics'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Game analysis screen mounts for a regular NBA fixture', (tester) async {
    const home = NbaTeam(id: 'bos', name: 'Boston Celtics', abbreviation: 'BOS');
    const away = NbaTeam(id: 'nyk', name: 'New York Knicks', abbreviation: 'NYK');
    final game = NbaGame(
      id: 'game-2',
      scheduledStart: DateTime.utc(2026, 11, 21, 18),
      status: 'scheduled',
      homeTeam: home,
      awayTeam: away,
    );
    await tester.pumpWidget(MaterialApp(home: GameAnalysisScreen(game: game)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('Análisis del partido'), findsOneWidget);
    expect(find.text('New York Knicks vs Boston Celtics'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Matchup card renders a forecast without head-to-head data', (tester) async {
    final forecast = NbaForecast(
      gameId: 'game-3',
      scheduledStart: DateTime.utc(2026, 11, 21, 18),
      homeTeam: 'Boston Celtics',
      awayTeam: 'New York Knicks',
      predictedWinner: 'Boston Celtics',
      predictedHomeScore: 112,
      predictedAwayScore: 106,
      homeWinProbability: 0.64,
      awayWinProbability: 0.36,
      homeRecentRecord: '7-3',
      awayRecentRecord: '5-5',
      homeSample: 10,
      awaySample: 10,
      teamBoxscore: {},
    );
    await tester.pumpWidget(MaterialApp(home: Scaffold(
      body: MatchupPredictionCard(
        forecast: forecast, homeTeam: null, awayTeam: null, players: const [], showHeadToHead: false,
      ),
    )));
    await tester.pump();
    expect(find.text('Boston Celtics'), findsWidgets);
    expect(find.textContaining('112'), findsWidgets);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
