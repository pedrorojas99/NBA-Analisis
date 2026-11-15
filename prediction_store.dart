import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/prediction.dart';

class PredictionStore {
  static const _key = 'nba_analytics_predictions_v1';

  Future<List<Prediction>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw) as List;
      return list.map((e) => Prediction.fromJson(Map<String, dynamic>.from(e))).toList()
        ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    } catch (_) {
      return [];
    }
  }

  Future<void> add(Prediction prediction) async {
    final all = await load();
    if (all.any((p) => p.id == prediction.id)) {
      throw StateError('El pronóstico ya existe.');
    }
    all.add(prediction);
    await _save(all);
  }

  // Only actual-result fields may change; original forecast is never rewritten.
  Future<void> recordActual(String id, int home, int away) async {
    final all = await load();
    final index = all.indexWhere((p) => p.id == id);
    if (index < 0) throw StateError('Pronóstico no encontrado.');
    if (all[index].isSettled) throw StateError('Este pronóstico ya tiene resultado y no se modifica.');
    all[index] = all[index].settle(home, away);
    await _save(all);
  }

  Future<void> _save(List<Prediction> all) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(all.map((p) => p.toJson()).toList()));
  }
}
