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
        brightness: Brightness.light,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1769AA),
          brightness: Brightness.light,
          primary: const Color(0xFF1769AA),
          secondary: const Color(0xFFEF8A4C),
          surface: Colors.white,
        ),
        scaffoldBackgroundColor: const Color(0xFFF7F9FC),
        iconTheme: const IconThemeData(size: 20),
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: Color(0xFF17324D),
          elevation: 0,
          surfaceTintColor: Colors.white,
        ),
        cardTheme: const CardThemeData(
          color: Colors.white,
          elevation: 1,
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(14))),
        ),
        navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: Colors.white,
          indicatorColor: Color(0xFFDCEBFA),
          labelTextStyle: WidgetStatePropertyAll(TextStyle(fontWeight: FontWeight.w700)),
        ),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
