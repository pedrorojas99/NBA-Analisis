import 'package:flutter/material.dart';
import 'player_stats_screen.dart';
import 'team_stats_screen.dart';

class SearchHubScreen extends StatelessWidget {
  const SearchHubScreen({super.key});

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    child: Column(children: [
      Material(
        color: Theme.of(context).colorScheme.surface,
        child: const TabBar(tabs: [
          Tab(icon: Icon(Icons.person_search), text: 'Jugadores'),
          Tab(icon: Icon(Icons.shield), text: 'Equipos'),
        ]),
      ),
      const Expanded(child: TabBarView(children: [
        PlayerStatsScreen(),
        TeamStatsScreen(),
      ])),
    ]),
  );
}
