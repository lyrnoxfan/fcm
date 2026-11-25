plugins {
    id("org.jetbrains.kotlin.jvm")
}

sourceSets {
    main {
        kotlin.setSrcDirs(listOf("../android/app/src/main/java"))
        kotlin.include("com/focusguard/core/UsageAggregation.kt", "com/focusguard/core/PolicyEngine.kt")
    }
    test {
        kotlin.setSrcDirs(listOf("../android/app/src/test/java"))
        kotlin.include("com/focusguard/core/UsageAggregationTest.kt", "com/focusguard/core/PolicyEngineTest.kt")
    }
}

dependencies {
    testImplementation(kotlin("test-junit"))
    testImplementation("junit:junit:4.13.2")
}

tasks.test { useJUnit() }
