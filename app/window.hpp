#pragma once

#include <string>

namespace doofbook_app {

bool runApplication(const std::string& initialWorkbookPath, std::string* errorMessage = nullptr);

}