plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing comes from environment variables (GitHub Actions secrets).
// Without them the release build is signed with the debug key so it still installs.
val ksFile = System.getenv("WASL_KEYSTORE_FILE")

android {
    namespace = "com.muhannadsatlink.wasl"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.muhannadsatlink.wasl"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("WASL_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("WASL_VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        if (ksFile != null) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("WASL_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WASL_KEY_ALIAS")
                keyPassword = System.getenv("WASL_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
