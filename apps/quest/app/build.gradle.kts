plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.jetbrains.kotlin.android)
  alias(libs.plugins.meta.spatial.plugin)
  alias(libs.plugins.jetbrains.kotlin.plugin.compose)
}

android {
  namespace = "gg.vlm.spaces"
  //noinspection GradleDependency
  compileSdk = 34

  defaultConfig {
    applicationId = "gg.vlm.spaces"
    minSdk = 34
    // Horizon OS is Android 14 (API level 34)
    //noinspection OldTargetApi,ExpiredTargetSdkVersion
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0"
  }

  // Release signing: the four VLM_QUEST_* properties live in ~/.gradle/gradle.properties (see STORE.md), never in the repo.
  // Without them the release build still assembles, unsigned, and warns.
  val keystorePath = providers.gradleProperty("VLM_QUEST_KEYSTORE").orNull
  val keystorePassword = providers.gradleProperty("VLM_QUEST_KEYSTORE_PASSWORD").orNull
  val keyAlias = providers.gradleProperty("VLM_QUEST_KEY_ALIAS").orNull
  val keyPassword = providers.gradleProperty("VLM_QUEST_KEY_PASSWORD").orNull
  val releaseSigned =
      keystorePath != null && keystorePassword != null && keyAlias != null && keyPassword != null

  signingConfigs {
    if (releaseSigned) {
      create("release") {
        storeFile = file(keystorePath!!.replaceFirst("~", System.getProperty("user.home")))
        storePassword = keystorePassword
        this.keyAlias = keyAlias
        this.keyPassword = keyPassword
      }
    }
  }

  buildTypes {
    release {
      // Minify stays off: the Spatial SDK documents no keep rules.
      isMinifyEnabled = false
      if (releaseSigned) {
        signingConfig = signingConfigs.getByName("release")
      } else {
        logger.warn(
            "VLM Quest: VLM_QUEST_KEYSTORE* properties are not set in ~/.gradle/gradle.properties; the release build will be UNSIGNED (see apps/quest/STORE.md)."
        )
      }
    }
  }

  packaging { resources.excludes.add("META-INF/LICENSE") }

  lint {
    abortOnError = false
    checkReleaseBuilds = false
  }

  buildFeatures {
    buildConfig = true
    compose = true
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  // android.util.Log and the like do nothing in unit tests (the visitor controller's tests reach its log lines).
  testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation("androidx.security:security-crypto:1.1.0-alpha06")
  implementation("io.nayuki:qrcodegen:1.8.0")
  testImplementation(libs.junit)
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

  implementation(libs.meta.spatial.sdk.base)
  implementation(libs.meta.spatial.sdk.compose)
  implementation(libs.meta.spatial.sdk.toolkit)
  implementation(libs.meta.spatial.sdk.vr)
  implementation(libs.meta.spatial.sdk.mruk)
  implementation(libs.meta.spatial.sdk.uiset)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.media3.exoplayer)
  implementation(libs.media3.hls)

  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.ui)
  implementation(libs.androidx.ui.graphics)
  implementation(libs.androidx.material3)
}

// The ring-marker synthetic test set (apps/ring-marker/testset), read by RingDetectorTest.
val ringMarkerDir = file("../../ring-marker")
val ringTestset by
    tasks.registering(Exec::class) {
      description = "Generates the ring-marker synthetic test set with python3 -m ringmarker.testset."
      workingDir = ringMarkerDir
      commandLine("python3", "-m", "ringmarker.testset", "testset")
      inputs.files(fileTree(ringMarkerDir.resolve("ringmarker")) { include("*.py") })
      outputs.dir(ringMarkerDir.resolve("testset"))
    }

tasks.matching { it.name == "testDebugUnitTest" }.configureEach { dependsOn(ringTestset) }
