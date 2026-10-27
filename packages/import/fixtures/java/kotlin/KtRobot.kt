package org.firstinspires.ftc.teamcode.zenith

import org.horizon36596.zenith.ivy.NamedCommands

/** Kotlin registrations: trailing lambdas, const vals and an enum class. */
enum class Gate { OPEN, CLOSED }

object KtNames {
    const val FEED = "feed"
}

class KtRobot {
    fun registerCommands() {
        NamedCommands.register(KtNames.FEED) { args, _ ->
            Feed(NamedCommands.argInt(args, "feed", "count"))
        }
        NamedCommands.register("gate", { args, ctx ->
            SetGate(NamedCommands.argEnum(args, "gate", "position", Gate::class.java, Gate.CLOSED))
        })
        NamedCommands.register("template$FEED") { _, _ -> Nothing() }
        NamedCommands.registerCondition("gateOpen") { gate.isOpen }
        /* Kotlin block comments /* nest */ NamedCommands.register("nested", ...) */
    }
}
