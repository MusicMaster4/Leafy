import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val leafyReleaseKeystore = System.getenv("LEAFY_ANDROID_KEYSTORE_PATH")
val leafyReleaseStorePassword = System.getenv("LEAFY_ANDROID_KEYSTORE_PASSWORD")
val leafyReleaseKeyAlias = System.getenv("LEAFY_ANDROID_KEY_ALIAS")
val leafyReleaseKeyPassword = System.getenv("LEAFY_ANDROID_KEY_PASSWORD")

android {
    compileSdk = 36
    namespace = "app.leafy.financas"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.leafy.financas"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (!leafyReleaseKeystore.isNullOrBlank() &&
            !leafyReleaseStorePassword.isNullOrBlank() &&
            !leafyReleaseKeyAlias.isNullOrBlank() &&
            !leafyReleaseKeyPassword.isNullOrBlank()
        ) {
            create("leafyRelease") {
                storeFile = file(leafyReleaseKeystore)
                storePassword = leafyReleaseStorePassword
                keyAlias = leafyReleaseKeyAlias
                keyPassword = leafyReleaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            // GitHub release APKs use this signed variant; keep it hardened.
            isDebuggable = false
            isJniDebuggable = false
            isMinifyEnabled = false
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("leafyRelease")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.17.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.14.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // Bundled OCR keeps receipt images and rendered PDF pages on the device.
    implementation("com.google.mlkit:text-recognition:16.0.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}

apply(from = "tauri.build.gradle.kts")
