import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'screens/home_screen.dart';

const supabaseUrl = 'https://sjzfrrwbirnaoqqgxblv.supabase.co';
const supabasePublishableKey = 'sb_publishable_6GMybhvJBAFCf7gMR2-hPw_EMxBPQV7';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(url: supabaseUrl, publishableKey: supabasePublishableKey);
  runApp(const NbaAnalyticsApp());
}

class NbaAnalyticsApp extends StatefulWidget {
  const NbaAnalyticsApp({super.key});

  @override
  State<NbaAnalyticsApp> createState() => _NbaAnalyticsAppState();
}

class _NbaAnalyticsAppState extends State<NbaAnalyticsApp> {
  int themeIndex = 0;

  @override
  void initState() {
    super.initState();
    _loadTheme();
  }

  Future<void> _loadTheme() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() => themeIndex = prefs.getInt('nba_theme_index')?.clamp(0, 2).toInt() ?? 0);
  }

  Future<void> _setTheme(int value) async {
    final safeValue = value.clamp(0, 2).toInt();
    setState(() => themeIndex = safeValue);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt('nba_theme_index', safeValue);
  }

  ThemeData _buildTheme({
    required Color seed,
    required Color background,
    required Color surface,
    required Color appBarForeground,
    required Brightness brightness,
    required Color secondary,
  }) {
    final scheme = ColorScheme.fromSeed(
      seedColor: seed,
      brightness: brightness,
    ).copyWith(
      primary: seed,
      secondary: secondary,
      surface: surface,
    );
    return ThemeData(
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
      iconTheme: IconThemeData(size: 20, color: scheme.onSurface),
      appBarTheme: AppBarTheme(
        backgroundColor: surface,
        foregroundColor: appBarForeground,
        elevation: 0,
        surfaceTintColor: surface,
      ),
      cardTheme: CardThemeData(
        color: surface,
        elevation: brightness == Brightness.dark ? 2 : 1,
        margin: EdgeInsets.zero,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(20)),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: surface,
        indicatorColor: secondary.withValues(alpha: 0.20),
        labelTextStyle: const WidgetStatePropertyAll(
          TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
      useMaterial3: true,
    );
  }

  ThemeData get _theme {
    switch (themeIndex) {
      case 1:
        return _buildTheme(
          seed: const Color(0xFFB85C38),
          secondary: const Color(0xFFD99A52),
          background: const Color(0xFFFFF5EA),
          surface: const Color(0xFFFFFCF7),
          appBarForeground: const Color(0xFF4A2D22),
          brightness: Brightness.light,
        );
      case 2:
        return _buildTheme(
          seed: const Color(0xFFA84D2C),
          secondary: const Color(0xFFE7A34B),
          background: const Color(0xFFFFF0E6),
          surface: const Color(0xFFFFF9F4),
          appBarForeground: const Color(0xFF4B281E),
          brightness: Brightness.light,
        );
      default:
        return _buildTheme(
          seed: const Color(0xFFB94D2B),
          secondary: const Color(0xFFE8752E),
          background: const Color(0xFFFFF8F3),
          surface: const Color(0xFFFFFEFC),
          appBarForeground: const Color(0xFF4A2D22),
          brightness: Brightness.light,
        );
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'NBA Analytics',
    debugShowCheckedModeBanner: false,
    theme: _theme,
    home: HomeScreen(
      themeIndex: themeIndex,
      onThemeChanged: _setTheme,
    ),
  );
}
