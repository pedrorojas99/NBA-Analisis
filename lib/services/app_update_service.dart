import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

class AppUpdateInfo {
  final int buildNumber;
  final String version;
  final String apkUrl;
  final String releaseUrl;

  const AppUpdateInfo({
    required this.buildNumber,
    required this.version,
    required this.apkUrl,
    required this.releaseUrl,
  });
}

class AppUpdateService {
  static const _releaseApi =
      'https://api.github.com/repos/pedrorojas99/NBA-Analisis/releases/latest';

  Future<AppUpdateInfo?> checkForUpdate() async {
    final response = await http.get(
      Uri.parse(_releaseApi),
      headers: const {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    ).timeout(const Duration(seconds: 20));

    if (response.statusCode != 200) {
      throw Exception('GitHub respondió con código ${response.statusCode}.');
    }

    final release = jsonDecode(response.body) as Map<String, dynamic>;
    final tag = (release['tag_name'] ?? '').toString();
    final match = RegExp(r'^build-(\\d+)$').firstMatch(tag);
    if (match == null) {
      throw Exception('La versión publicada no tiene un número válido.');
    }

    final remoteBuild = int.parse(match.group(1)!);
    final package = await PackageInfo.fromPlatform();
    final localBuild = int.tryParse(package.buildNumber) ?? 0;
    if (remoteBuild <= localBuild) return null;

    final assets = (release['assets'] as List<dynamic>? ?? []);
    final apk = assets.cast<Map<String, dynamic>>().where((asset) {
      return (asset['name'] ?? '').toString().toLowerCase().endsWith('.apk');
    }).firstOrNull;
    if (apk == null) throw Exception('La publicación no contiene una APK.');

    return AppUpdateInfo(
      buildNumber: remoteBuild,
      version: (release['name'] ?? tag).toString(),
      apkUrl: (apk['browser_download_url'] ?? '').toString(),
      releaseUrl: (release['html_url'] ?? '').toString(),
    );
  }

  Future<void> downloadAndInstall(
    AppUpdateInfo update, {
    void Function(double? progress, int received, int total)? onProgress,
  }) async {
    final uri = Uri.parse(update.apkUrl);
    final request = http.Request('GET', uri);
    final client = http.Client();
    late final http.StreamedResponse response;
    try {
      response = await client.send(request)
          .timeout(const Duration(seconds: 45));
    } catch (_) {
      client.close();
      rethrow;
    }
    if (response.statusCode != 200) {
      client.close();
      throw Exception('No se pudo descargar la APK (HTTP ${response.statusCode}).');
    }

    final directory = await getTemporaryDirectory();
    final file = File('${directory.path}/nba-analytics-update.apk');
    final sink = file.openWrite();
    var received = 0;
    final total = response.contentLength ?? 0;
    try {
      await for (final chunk in response.stream) {
        sink.add(chunk);
        received += chunk.length;
        onProgress?.call(
          total > 0 ? (received / total).clamp(0.0, 1.0) : null,
          received,
          total,
        );
      }
      await sink.flush();
    } finally {
      await sink.close();
      client.close();
    }

    if (!await file.exists() || await file.length() < 1000000) {
      throw Exception('La descarga de la APK está incompleta.');
    }
    if (total > 0 && received < total) {
      throw Exception('La descarga se interrumpió antes de completarse.');
    }

    final result = await OpenFilex.open(
      file.path,
      type: 'application/vnd.android.package-archive',
    );
    if (result.type != ResultType.done) {
      throw Exception('Android no pudo abrir el instalador: ${result.message}');
    }
  }
}
