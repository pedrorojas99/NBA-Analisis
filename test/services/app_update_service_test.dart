import 'package:flutter_test/flutter_test.dart';
import 'package:nba_analytics/services/app_update_service.dart';

void main() {
  test('AppUpdateInfo conserva los datos de la versión publicada', () {
    const update = AppUpdateInfo(
      buildNumber: 161,
      version: 'NBA Analytics build 161',
      apkUrl: 'https://example.com/app.apk',
      releaseUrl: 'https://example.com/release',
    );

    expect(update.buildNumber, 161);
    expect(update.version, 'NBA Analytics build 161');
    expect(update.apkUrl, endsWith('.apk'));
    expect(update.releaseUrl, contains('/release'));
  });
}
