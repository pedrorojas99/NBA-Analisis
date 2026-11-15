import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'screens/home_screen.dart';

const supabaseUrl = 'https://sjzfrrwbirnaoqqgxblv.supabase.co';
const supabasePublishableKey = 'sb_publishable_6GMybhvJBAFCf7gMR2-hPw_EMxBPQV7';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(url: supabaseUrl, publishableKey: supabasePublishableKey);
  runApp(const NbaAnalyticsApp());
}

class NbaAnalyticsApp extends StatelessWidget {
  const NbaAnalyticsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NBA Analytics',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFEF6C35),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF10141D),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
